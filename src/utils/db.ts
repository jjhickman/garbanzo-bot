/**
 * SQLite persistent storage — single database for all bot state.
 *
 * Tables:
 * - messages: conversation history per group (replaces context.json)
 * - moderation_log: flagged messages with metadata
 * - daily_stats: archived daily digest data
 *
 * Uses better-sqlite3 (synchronous, fast, no async overhead).
 */

import Database from 'better-sqlite3';
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import { logger } from '../middleware/logger.js';
import { PROJECT_ROOT } from './config.js';

const DB_DIR = resolve(PROJECT_ROOT, 'data');
const DB_PATH = resolve(DB_DIR, 'garbanzo.db');

// Ensure data directory exists
mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

logger.info({ path: DB_PATH }, 'SQLite database opened');

// ── Schema ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_ts
    ON messages (chat_jid, timestamp DESC);

  CREATE TABLE IF NOT EXISTS moderation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    reason TEXT NOT NULL,
    severity TEXT NOT NULL,
    source TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_moderation_ts
    ON moderation_log (timestamp DESC);

  CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL
  );
`);

// ── Prepared statements ─────────────────────────────────────────────

const insertMessage = db.prepare(`
  INSERT INTO messages (chat_jid, sender, text, timestamp)
  VALUES (?, ?, ?, ?)
`);

const selectRecentMessages = db.prepare(`
  SELECT sender, text, timestamp FROM messages
  WHERE chat_jid = ?
  ORDER BY timestamp DESC
  LIMIT ?
`);

const pruneOldMessages = db.prepare(`
  DELETE FROM messages
  WHERE chat_jid = ? AND id NOT IN (
    SELECT id FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?
  )
`);

const insertModerationLog = db.prepare(`
  INSERT INTO moderation_log (chat_jid, sender, text, reason, severity, source, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const selectModerationLogs = db.prepare(`
  SELECT * FROM moderation_log
  WHERE timestamp > ?
  ORDER BY timestamp DESC
`);

const upsertDailyStats = db.prepare(`
  INSERT INTO daily_stats (date, data) VALUES (?, ?)
  ON CONFLICT(date) DO UPDATE SET data = excluded.data
`);

// ── Public API: Messages ────────────────────────────────────────────

/** Max messages kept per chat in the database */
const MAX_MESSAGES_PER_CHAT = 100;

export interface DbMessage {
  sender: string;
  text: string;
  timestamp: number;
}

/**
 * Store a message and prune old ones beyond the limit.
 */
export function storeMessage(
  chatJid: string,
  sender: string,
  text: string,
): void {
  const bare = sender.split('@')[0].split(':')[0];
  const truncated = text.length > 500 ? text.slice(0, 497) + '...' : text;
  const ts = Math.floor(Date.now() / 1000);

  insertMessage.run(chatJid, bare, truncated, ts);

  // Prune beyond limit (keep last N per chat)
  pruneOldMessages.run(chatJid, chatJid, MAX_MESSAGES_PER_CHAT);
}

/**
 * Get recent messages for a chat (returned oldest-first for prompt context).
 */
export function getMessages(chatJid: string, limit: number = 15): DbMessage[] {
  const rows = selectRecentMessages.all(chatJid, limit) as DbMessage[];
  return rows.reverse(); // oldest first
}

/**
 * Format recent messages as a string for AI prompts.
 */
export function formatMessagesForPrompt(chatJid: string, limit: number = 15): string {
  const messages = getMessages(chatJid, limit);
  if (messages.length === 0) return '';

  const lines = messages.map((m) => `[${m.sender}]: ${m.text}`);
  return [
    'Recent conversation (oldest first):',
    ...lines,
  ].join('\n');
}

// ── Public API: Moderation ──────────────────────────────────────────

export interface ModerationEntry {
  chatJid: string;
  sender: string;
  text: string;
  reason: string;
  severity: string;
  source: string;
  timestamp: number;
}

export function logModeration(entry: ModerationEntry): void {
  insertModerationLog.run(
    entry.chatJid,
    entry.sender,
    entry.text,
    entry.reason,
    entry.severity,
    entry.source,
    entry.timestamp,
  );
}

export function getModerationLogs(sinceTimestamp: number): ModerationEntry[] {
  return selectModerationLogs.all(sinceTimestamp) as ModerationEntry[];
}

// ── Public API: Strikes ─────────────────────────────────────────────

const countStrikesBySender = db.prepare(`
  SELECT COUNT(*) as count FROM moderation_log
  WHERE sender = ?
`);

const selectStrikesBySender = db.prepare(`
  SELECT chat_jid, reason, severity, source, timestamp FROM moderation_log
  WHERE sender = ?
  ORDER BY timestamp DESC
`);

const selectRepeatOffenders = db.prepare(`
  SELECT sender, COUNT(*) as strike_count,
    MAX(timestamp) as last_flag,
    GROUP_CONCAT(DISTINCT reason) as reasons
  FROM moderation_log
  GROUP BY sender
  HAVING strike_count >= ?
  ORDER BY strike_count DESC
`);

export interface StrikeSummary {
  sender: string;
  strike_count: number;
  last_flag: number;
  reasons: string;
}

/** Get total strike count for a sender (bare JID) */
export function getStrikeCount(senderJid: string): number {
  const bare = senderJid.split('@')[0].split(':')[0];
  const row = countStrikesBySender.get(bare) as { count: number };
  return row.count;
}

/** Get all strikes for a sender */
export function getStrikes(senderJid: string): ModerationEntry[] {
  const bare = senderJid.split('@')[0].split(':')[0];
  return selectStrikesBySender.all(bare) as ModerationEntry[];
}

/** Get all users with N+ strikes */
export function getRepeatOffenders(minStrikes: number = 3): StrikeSummary[] {
  return selectRepeatOffenders.all(minStrikes) as StrikeSummary[];
}

// ── Public API: Daily Stats ─────────────────────────────────────────

export function saveDailyStats(date: string, data: string): void {
  upsertDailyStats.run(date, data);
}

// ── Cleanup ─────────────────────────────────────────────────────────

export function closeDb(): void {
  db.close();
  logger.info('SQLite database closed');
}
