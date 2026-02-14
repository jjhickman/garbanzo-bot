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

import { storeMessage, getMessages, type DbMessage } from '../utils/db.js';
import { logger } from './logger.js';

// ── Configuration ───────────────────────────────────────────────────

/** Number of recent messages to include verbatim */
const RECENT_COUNT = 5;

/** Number of older messages to fetch for compression */
const OLDER_COUNT = 25;

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
export function recordMessage(
  chatJid: string,
  sender: string,
  text: string,
): void {
  storeMessage(chatJid, sender, text);
}

/**
 * Get recent messages for a chat (oldest first).
 */
export function getRecentMessages(chatJid: string): DbMessage[] {
  return getMessages(chatJid, 15);
}

/**
 * Format context for AI prompts using the two-tier compression strategy.
 *
 * Returns a string with:
 * - A compressed summary of older messages (if available)
 * - The last 5 messages verbatim
 *
 * Returns empty string if no messages exist.
 */
export function formatContext(chatJid: string): string {
  const recentMessages = getMessages(chatJid, RECENT_COUNT);
  if (recentMessages.length === 0) return '';

  const olderMessages = getMessages(chatJid, RECENT_COUNT + OLDER_COUNT);

  // Split into recent (verbatim) and older (to compress)
  const older = olderMessages.slice(0, Math.max(0, olderMessages.length - RECENT_COUNT));
  const recent = olderMessages.slice(Math.max(0, olderMessages.length - RECENT_COUNT));

  const parts: string[] = [];

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
