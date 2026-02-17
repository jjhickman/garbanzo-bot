/**
 * Lightweight post-retrieval reranker.
 *
 * Merges message-level hits and session summary hits into a single ranked
 * list using a unified scoring model:
 *
 * 1. Normalized source score (vector cosine or keyword overlap)
 * 2. Recency decay (exponential decay by age in hours)
 * 3. Source type bonus (session summaries get a small boost since they
 *    represent distilled multi-message context)
 * 4. Query token overlap tie-break
 * 5. Deduplication (messages already covered by a session window are demoted)
 */

import type { DbMessage, SessionSummaryHit } from './db-types.js';

// ── Types ───────────────────────────────────────────────────────────

export type CandidateSource = 'message' | 'session';

export interface RankedCandidate {
  source: CandidateSource;
  /** Unified relevance score (higher = more relevant) */
  score: number;
  /** Display text for context injection */
  text: string;
  /** Sender (message) or participant list (session) */
  attribution: string;
  /** Unix epoch seconds */
  timestamp: number;
  /** Original message or session data */
  original: DbMessage | SessionSummaryHit;
}

// ── Scoring parameters ──────────────────────────────────────────────

/** Half-life for recency decay in hours (score halves every N hours) */
const RECENCY_HALF_LIFE_HOURS = 72;

/** Bonus multiplier for session summary candidates */
const SESSION_TYPE_BONUS = 1.25;

/** Weight for query token overlap component (0-1) */
const TOKEN_OVERLAP_WEIGHT = 0.3;

/** Weight for recency component (0-1) */
const RECENCY_WEIGHT = 0.25;

/** Weight for base relevance score component (0-1) */
const BASE_SCORE_WEIGHT = 0.45;

// ── Helpers ─────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return new Set(tokens.filter((t) => t.length >= 3));
}

function queryTokenOverlap(candidateText: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const candidateTokens = tokenize(candidateText);
  let hits = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.size;
}

function recencyScore(timestampSec: number, nowSec: number): number {
  const ageHours = Math.max(0, (nowSec - timestampSec) / 3600);
  return Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS);
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Merge and rerank message hits and session summary hits into a single
 * unified ranked list.
 *
 * @param messages - Message-level retrieval results (from vector/keyword search)
 * @param sessions - Session summary retrieval results
 * @param query - The user's query text for token overlap scoring
 * @param limit - Maximum number of candidates to return
 * @returns Ranked candidates, highest score first
 */
export function rerankCandidates(
  messages: DbMessage[],
  sessions: SessionSummaryHit[],
  query: string,
  limit: number,
): RankedCandidate[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const queryTokens = tokenize(query);

  // Build session time ranges for deduplication
  const sessionRanges = sessions.map((s) => ({
    chatJid: s.sessionId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  }));

  const candidates: RankedCandidate[] = [];

  // Score messages
  for (const msg of messages) {
    // Check if this message falls within a session window we already have
    const coveredBySession = sessionRanges.some(
      (range) => msg.timestamp >= range.startedAt && msg.timestamp <= range.endedAt,
    );

    const overlap = queryTokenOverlap(msg.text, queryTokens);
    const recency = recencyScore(msg.timestamp, nowSec);

    // Messages covered by session summaries get a penalty since
    // the session summary already captures their context
    const coveragePenalty = coveredBySession ? 0.5 : 1.0;

    const score = (
      (BASE_SCORE_WEIGHT * overlap)
      + (RECENCY_WEIGHT * recency)
      + (TOKEN_OVERLAP_WEIGHT * overlap)
    ) * coveragePenalty;

    candidates.push({
      source: 'message',
      score,
      text: msg.text,
      attribution: msg.sender,
      timestamp: msg.timestamp,
      original: msg,
    });
  }

  // Score sessions
  // Normalize session scores: find the max raw score for proportional scaling
  const maxSessionScore = sessions.length > 0
    ? Math.max(...sessions.map((s) => s.score), 1)
    : 1;

  for (const session of sessions) {
    const normalizedBaseScore = session.score / maxSessionScore;
    const overlap = queryTokenOverlap(session.summaryText, queryTokens);
    const recency = recencyScore(session.endedAt, nowSec);

    const score = (
      (BASE_SCORE_WEIGHT * normalizedBaseScore)
      + (RECENCY_WEIGHT * recency)
      + (TOKEN_OVERLAP_WEIGHT * overlap)
    ) * SESSION_TYPE_BONUS;

    const topParticipants = session.participants.slice(0, 4).join(', ');
    const topics = session.topicTags.length > 0 ? ` | topics: ${session.topicTags.join(', ')}` : '';

    candidates.push({
      source: 'session',
      score,
      text: session.summaryText,
      attribution: `${topParticipants}${topics}`,
      timestamp: session.endedAt,
      original: session,
    });
  }

  // Sort by score descending, then by timestamp descending for ties
  candidates.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
    return b.timestamp - a.timestamp;
  });

  return candidates.slice(0, limit);
}
