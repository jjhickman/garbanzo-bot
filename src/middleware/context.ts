/**
 * Conversation context — backed by SQLite with compression.
 *
 * Instead of dumping all 15 recent messages raw into the AI prompt,
 * this module uses a two-tier approach:
 *
 * 1. **Recent (last 5 messages):** Included verbatim — the AI needs
 *    exact wording for the immediate conversation.
 * 2. **Older (messages 6–30):** Compressed into a ~100-word summary.
 *    The summary is cached per group and invalidated when new messages
 *    arrive (checked via message count).
 *
 * This reduces prompt token usage by ~60% while preserving the context
 * the AI actually needs.
 */

import {
  storeMessage,
  getMessages,
  searchRelevantMessages,
  searchRelevantSessionSummaries,
  type DbMessage,
} from '../utils/db.js';
import { rerankCandidates } from '../utils/reranker.js';
import { logger } from './logger.js';
import { config } from '../utils/config.js';
import { recordSessionSummaryRetrieval } from './stats.js';

// ── Configuration ───────────────────────────────────────────────────

/** Number of recent messages to include verbatim */
const RECENT_COUNT = 8;

/** Number of older messages to fetch for compression */
const OLDER_COUNT = 220;

/** Number of semantic/keyword relevant messages to surface */
const RELEVANT_COUNT = 6;
const SESSION_RELEVANT_COUNT = config.CONTEXT_SESSION_MAX_RETRIEVED;

/** Max age for cached summaries (minutes) */
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Summary cache ───────────────────────────────────────────────────

interface CacheEntry {
  summary: string;
  messageCount: number; // count when summary was generated
  timestamp: number;
}

const summaryCache = new Map<string, CacheEntry>();

// ── Public API ──────────────────────────────────────────────────────

/**
 * Record an incoming message. Call for every text message the bot observes.
 */
export async function recordMessage(
  chatJid: string,
  sender: string,
  text: string,
): Promise<void> {
  await storeMessage(chatJid, sender, text);
}

/**
 * Format context for AI prompts using the two-tier compression strategy.
 *
 * Returns a string with:
 * - Query-relevant earlier messages (pgvector in Postgres, keyword fallback otherwise)
 * - A compressed summary of older messages (if available)
 * - The most recent messages verbatim
 *
 * Returns empty string if no messages exist.
 */
export async function formatContext(chatJid: string, queryText: string = ''): Promise<string> {
  const contextWindow = await getMessages(chatJid, RECENT_COUNT + OLDER_COUNT);
  if (contextWindow.length === 0) return '';

  // Split into recent (verbatim) and older (to compress)
  const older = contextWindow.slice(0, Math.max(0, contextWindow.length - RECENT_COUNT));
  const recent = contextWindow.slice(Math.max(0, contextWindow.length - RECENT_COUNT));

  const recentKeys = new Set(recent.map((m) => `${m.timestamp}:${m.sender}:${m.text}`));

  const relevantRaw = queryText.trim()
    ? await searchRelevantMessages(chatJid, queryText, RELEVANT_COUNT)
    : [];
  const relevant = relevantRaw.filter((m) => !recentKeys.has(`${m.timestamp}:${m.sender}:${m.text}`));

  const sessionHits = queryText.trim()
    ? await searchRelevantSessionSummaries(chatJid, queryText, SESSION_RELEVANT_COUNT)
    : [];

  const parts: string[] = [];

  // Rerank merged message + session candidates when both are available
  if (relevant.length > 0 && sessionHits.length > 0) {
    const ranked = rerankCandidates(
      relevant,
      sessionHits,
      queryText,
      RELEVANT_COUNT + SESSION_RELEVANT_COUNT,
    );

    const messageParts: string[] = [];
    const sessionParts: string[] = [];
    let sessionInjectedChars = 0;
    let sessionCount = 0;

    for (const candidate of ranked) {
      if (candidate.source === 'message') {
        messageParts.push(`[${candidate.attribution}]: ${candidate.text}`);
      } else {
        const hit = candidate.original as import('../utils/db.js').SessionSummaryHit;
        const startIso = new Date(hit.startedAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
        const endIso = new Date(hit.endedAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
        const summaryText = hit.summaryText.length > 420 ? `${hit.summaryText.slice(0, 417)}...` : hit.summaryText;
        sessionInjectedChars += summaryText.length;
        sessionCount += 1;
        const topics = hit.topicTags.length > 0 ? `topics: ${hit.topicTags.join(', ')}` : 'topics: n/a';
        sessionParts.push(`- ${startIso} to ${endIso} | ${hit.messageCount} msgs | ${topics}`);
        sessionParts.push(`  ${summaryText}`);
      }
    }

    if (messageParts.length > 0) {
      parts.push('Relevant earlier messages for this question:');
      parts.push(...messageParts);
      parts.push('');
    }

    if (sessionParts.length > 0) {
      parts.push('Relevant earlier session summaries:');
      parts.push(...sessionParts);
      recordSessionSummaryRetrieval(chatJid, sessionCount, sessionInjectedChars);
      parts.push('');
    }
  } else {
    // Fallback: render independently when only one source has results
    if (relevant.length > 0) {
      parts.push('Relevant earlier messages for this question:');
      for (const m of relevant) {
        parts.push(`[${m.sender}]: ${m.text}`);
      }
      parts.push('');
    }

    if (sessionHits.length > 0) {
      parts.push('Relevant earlier session summaries:');
      let injectedChars = 0;
      for (const hit of sessionHits) {
        const startIso = new Date(hit.startedAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
        const endIso = new Date(hit.endedAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
        const summaryText = hit.summaryText.length > 420 ? `${hit.summaryText.slice(0, 417)}...` : hit.summaryText;
        injectedChars += summaryText.length;
        const topics = hit.topicTags.length > 0 ? `topics: ${hit.topicTags.join(', ')}` : 'topics: n/a';
        parts.push(`- ${startIso} to ${endIso} | ${hit.messageCount} msgs | ${topics}`);
        parts.push(`  ${summaryText}`);
      }
      recordSessionSummaryRetrieval(chatJid, sessionHits.length, injectedChars);
      parts.push('');
    }
  }

  // Older messages — compressed summary
  if (older.length >= 3) {
    const summary = getOrCreateSummary(chatJid, older);
    if (summary) {
      parts.push(`Earlier conversation summary: ${summary}`);
      parts.push('');
    }
  }

  // Recent messages — verbatim
  if (recent.length > 0) {
    parts.push('Recent messages (most recent conversation):');
    for (const m of recent) {
      parts.push(`[${m.sender}]: ${m.text}`);
    }
  }

  return parts.join('\n');
}

// ── Summary generation ──────────────────────────────────────────────

/**
 * Get a cached summary or generate a new one.
 * Uses a simple extractive approach (no AI call) to avoid
 * circular dependencies and extra API costs.
 */
function getOrCreateSummary(chatJid: string, messages: DbMessage[]): string | null {
  const cached = summaryCache.get(chatJid);
  const now = Date.now();

  // Check cache validity
  if (cached && cached.messageCount === messages.length && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.summary;
  }

  // Generate new summary using extractive compression
  const summary = compressMessages(messages);
  if (!summary) return null;

  summaryCache.set(chatJid, {
    summary,
    messageCount: messages.length,
    timestamp: now,
  });

  logger.debug({
    chatJid,
    inputMessages: messages.length,
    summaryLength: summary.length,
  }, 'Context summary generated');

  return summary;
}

/**
 * Extractive compression — no AI call needed.
 *
 * Strategy:
 * 1. Deduplicate participants
 * 2. Extract unique topics/keywords
 * 3. Keep messages with questions or key info
 * 4. Truncate each kept message to ~80 chars
 * 5. Cap total at ~400 chars
 */
function compressMessages(messages: DbMessage[]): string | null {
  if (messages.length === 0) return null;

  // Collect unique participants
  const participants = new Set(messages.map((m) => m.sender));

  // Score messages by importance
  const scored = messages.map((m) => ({
    msg: m,
    score: scoreMessage(m.text),
  }));

  // Keep the highest-scored messages
  scored.sort((a, b) => b.score - a.score);
  const kept = scored.slice(0, 8);

  // Re-sort by timestamp (chronological)
  kept.sort((a, b) => a.msg.timestamp - b.msg.timestamp);

  const participantList = [...participants].slice(0, 6).join(', ');
  const extraCount = participants.size > 6 ? ` +${participants.size - 6} more` : '';

  const lines = [
    `Participants: ${participantList}${extraCount}.`,
    ...kept.map((k) => {
      const text = k.msg.text.length > 80 ? k.msg.text.slice(0, 77) + '...' : k.msg.text;
      return `${k.msg.sender}: ${text}`;
    }),
  ];

  // Cap total length
  let result = lines.join(' | ');
  if (result.length > 500) {
    result = result.slice(0, 497) + '...';
  }

  return result;
}

/**
 * Score a message's importance for context compression.
 * Higher score = more likely to be kept in the summary.
 */
function scoreMessage(text: string): number {
  let score = 0;

  // Questions are important (someone needs an answer)
  if (text.includes('?')) score += 3;

  // URLs/links carry info
  if (/https?:\/\//.test(text)) score += 2;

  // Mentions of time/place (planning context)
  if (/\b(tomorrow|tonight|today|next\s+(week|friday|saturday)|at\s+\d|pm|am)\b/i.test(text)) score += 3;

  // Decisions/agreements
  if (/\b(let'?s|sounds good|I'm in|count me|confirmed|plan is)\b/i.test(text)) score += 2;

  // Longer messages tend to carry more substance
  if (text.length > 100) score += 1;
  if (text.length > 200) score += 1;

  // Short messages are usually low-value
  if (text.length < 15) score -= 2;

  // Emoji-only messages are noise
  if (/^[\p{Emoji}\s]+$/u.test(text)) score -= 3;

  return score;
}
