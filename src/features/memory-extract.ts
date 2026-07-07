/**
 * Automatic community-memory extraction.
 *
 * State is intentionally in-memory: per-chat extraction timestamps reset on
 * process restart (worst case: one extra extraction per active group after a
 * restart), which is acceptable because the feature is opportunistic and all
 * durable facts are persisted in the memory table.
 */

import { z } from 'zod';
import { getAIResponse } from '../ai/router.js';
import { logger } from '../middleware/logger.js';
import {
  addMemory,
  deleteMemory,
  getAllMemories,
  getMessages,
  searchMemory,
  type DbMessage,
  type MemoryEntry,
} from '../utils/db.js';
import { config } from '../utils/config.js';

const RECENT_MESSAGE_LIMIT = 40;
const MAX_EXTRACTED_FACTS = 3;
const MIN_FACT_LENGTH = 15;
const DEDUP_OVERLAP_THRESHOLD = 0.6;
const DISTINCTIVE_TOKEN_COUNT = 3;

const factSchema = z.object({
  category: z.enum(['events', 'venues', 'members', 'traditions', 'general']),
  fact: z.string().trim().min(1).max(140),
});

const factArraySchema = z.array(factSchema).max(MAX_EXTRACTED_FACTS);

type CandidateFact = z.infer<typeof factSchema>;

interface ExtractionState {
  lastExtractionAt: number;
  inFlight: boolean;
}

const extractionState = new Map<string, ExtractionState>();

export async function maybeExtractCommunityFacts(chatId: string, groupName: string): Promise<void> {
  if (!config.MEMORY_AUTO_EXTRACT) return;

  const state = getState(chatId);
  if (state.inFlight) return;

  const now = Date.now();
  const intervalMs = config.MEMORY_AUTO_EXTRACT_INTERVAL_MINUTES * 60 * 1000;
  if (now - state.lastExtractionAt < intervalMs) return;

  state.inFlight = true;
  try {
    // This hook fires once per bot reply, so gate on actual chat traffic:
    // only messages newer than the last extraction count toward the
    // threshold, and a quiet group never re-extracts the same window.
    const messages = await getMessages(chatId, RECENT_MESSAGE_LIMIT);
    const cutoffSeconds = Math.floor(state.lastExtractionAt / 1000);
    const freshCount = messages.filter((message) => message.timestamp > cutoffSeconds).length;
    if (freshCount < config.MEMORY_AUTO_EXTRACT_MIN_MESSAGES) return;

    await extractCommunityFacts(chatId, groupName, messages);
    state.lastExtractionAt = Date.now();
  } catch (err) {
    logger.warn({ err, chatId, groupName }, 'Automatic memory extraction failed');
  } finally {
    state.inFlight = false;
  }
}

function getState(chatId: string): ExtractionState {
  const existing = extractionState.get(chatId);
  if (existing) return existing;

  const created = {
    lastExtractionAt: 0,
    inFlight: false,
  };
  extractionState.set(chatId, created);
  return created;
}

async function extractCommunityFacts(chatId: string, groupName: string, messages: DbMessage[]): Promise<void> {
  if (messages.length === 0) return;

  const response = await getAIResponse(buildExtractionPrompt(groupName, messages), {
    groupName,
    groupJid: chatId,
    senderJid: 'memory-extract',
  });
  if (!response) return;

  const candidates = parseCandidates(response);
  if (candidates.length === 0) return;

  for (const candidate of candidates) {
    const fact = candidate.fact.trim();
    if (fact.length < MIN_FACT_LENGTH) continue;
    if (await isDuplicateFact(fact)) continue;

    await addMemory(fact, candidate.category, 'auto');
  }

  await pruneAutoMemoriesToCap();
}

function buildExtractionPrompt(groupName: string, messages: DbMessage[]): string {
  const formattedMessages = messages
    .map((message) => `[${message.sender}]: ${message.text}`)
    .join('\n');

  return [
    `Extract durable community memory from recent messages in the "${groupName}" WhatsApp group.`,
    '',
    'Return only a raw JSON array, or a fenced JSON array, with 0-3 objects.',
    'Each object must be: {"category":"events|venues|members|traditions|general","fact":"<one sentence, max 140 chars>"}',
    '',
    'Keep only long-term facts worth remembering: recurring events, venues, member roles/projects, or group traditions.',
    'Return [] for small talk, one-off plans, jokes, opinions, or anything not durable.',
    '',
    'Recent messages:',
    formattedMessages,
  ].join('\n');
}

function parseCandidates(response: string): CandidateFact[] {
  const rawJson = stripJsonFence(response.trim());
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    const result = factArraySchema.safeParse(parsed);
    if (!result.success) {
      logger.debug({ issues: result.error.issues }, 'Automatic memory extraction returned invalid facts');
      return [];
    }
    return result.data;
  } catch (err) {
    logger.debug({ err }, 'Automatic memory extraction returned malformed JSON');
    return [];
  }
}

function stripJsonFence(response: string): string {
  const fenceMatch = response.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? response;
}

export async function isDuplicateFact(candidate: string): Promise<boolean> {
  const candidateTokens = normalizedTokenSet(candidate);
  if (candidateTokens.size === 0) return false;

  const matches = new Map<number, MemoryEntry>();
  for (const token of distinctiveTokens(candidateTokens)) {
    const memories = await searchMemory(token, 10);
    for (const memory of memories) {
      if (memory.shared) continue;
      matches.set(memory.id, memory);
    }
  }

  for (const memory of matches.values()) {
    const overlap = jaccardOverlap(candidateTokens, normalizedTokenSet(memory.fact));
    if (overlap >= DEDUP_OVERLAP_THRESHOLD) return true;
  }

  return false;
}

function normalizedTokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map((token) => token.replace(/s$/, ''))
      .filter((token) => token.length >= 4),
  );
}

function distinctiveTokens(tokens: Set<string>): string[] {
  return [...tokens]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, DISTINCTIVE_TOKEN_COUNT);
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }

  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

async function pruneAutoMemoriesToCap(): Promise<void> {
  const autoMemories = (await getAllMemories())
    .filter((memory) => memory.source === 'auto')
    .sort((a, b) => a.created_at - b.created_at || a.id - b.id);

  const excess = autoMemories.length - config.MEMORY_AUTO_MAX_FACTS;
  if (excess <= 0) return;

  for (const memory of autoMemories.slice(0, excess)) {
    await deleteMemory(memory.id);
  }
}
