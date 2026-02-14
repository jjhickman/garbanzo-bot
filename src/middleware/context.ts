/**
 * Conversation context — backed by SQLite.
 *
 * Thin wrapper around db.ts message storage. Provides the same
 * public API (recordMessage, formatContext) but now persisted in
 * SQLite instead of a JSON file.
 */

import { storeMessage, formatMessagesForPrompt, getMessages, type DbMessage } from '../utils/db.js';

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
 * Format recent messages as a string for inclusion in AI prompts.
 * Returns empty string if no recent context.
 */
export function formatContext(chatJid: string): string {
  return formatMessagesForPrompt(chatJid, 15);
}
