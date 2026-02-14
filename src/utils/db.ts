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
import { mkdirSync, copyFileSync, readdirSync, unlinkSync } from 'fs';
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

  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fact TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    source TEXT NOT NULL DEFAULT 'owner',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_category
    ON memory (category);

  CREATE TABLE IF NOT EXISTS member_profiles (
    jid TEXT PRIMARY KEY,
    name TEXT,
    interests TEXT NOT NULL DEFAULT '[]',
    groups_active TEXT NOT NULL DEFAULT '[]',
    event_count INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    opted_in INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('suggestion', 'bug')),
    sender TEXT NOT NULL,
    group_jid TEXT,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'done')),
    upvotes INTEGER NOT NULL DEFAULT 0,
    upvoters TEXT NOT NULL DEFAULT '[]',
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_feedback_status
    ON feedback (status, timestamp DESC);
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

// ── Public API: Feedback (suggestions & bug reports) ────────────────

const insertFeedback = db.prepare(`
  INSERT INTO feedback (type, sender, group_jid, text, status, upvotes, upvoters, timestamp)
  VALUES (?, ?, ?, ?, 'open', 0, '[]', ?)
`);

const selectOpenFeedback = db.prepare(`
  SELECT * FROM feedback
  WHERE status = 'open'
  ORDER BY upvotes DESC, timestamp ASC
`);

const selectAllFeedback = db.prepare(`
  SELECT * FROM feedback
  ORDER BY timestamp DESC
  LIMIT ?
`);

const selectFeedbackById = db.prepare(`
  SELECT * FROM feedback WHERE id = ?
`);

const updateFeedbackStatus = db.prepare(`
  UPDATE feedback SET status = ? WHERE id = ?
`);

const updateFeedbackUpvote = db.prepare(`
  UPDATE feedback SET upvotes = ?, upvoters = ? WHERE id = ?
`);

export interface FeedbackEntry {
  id: number;
  type: 'suggestion' | 'bug';
  sender: string;
  group_jid: string | null;
  text: string;
  status: 'open' | 'accepted' | 'rejected' | 'done';
  upvotes: number;
  upvoters: string;
  timestamp: number;
}

/** Submit a new feature suggestion or bug report */
export function submitFeedback(
  type: 'suggestion' | 'bug',
  sender: string,
  groupJid: string | null,
  text: string,
): FeedbackEntry {
  const bare = sender.split('@')[0].split(':')[0];
  const ts = Math.floor(Date.now() / 1000);
  const result = insertFeedback.run(type, bare, groupJid, text, ts);
  return {
    id: Number(result.lastInsertRowid),
    type,
    sender: bare,
    group_jid: groupJid,
    text,
    status: 'open',
    upvotes: 0,
    upvoters: '[]',
    timestamp: ts,
  };
}

/** Get all open feedback items, sorted by upvotes (most popular first) */
export function getOpenFeedback(): FeedbackEntry[] {
  return selectOpenFeedback.all() as FeedbackEntry[];
}

/** Get recent feedback (any status) */
export function getRecentFeedback(limit: number = 20): FeedbackEntry[] {
  return selectAllFeedback.all(limit) as FeedbackEntry[];
}

/** Get a single feedback entry by ID */
export function getFeedbackById(id: number): FeedbackEntry | undefined {
  return selectFeedbackById.get(id) as FeedbackEntry | undefined;
}

/** Update the status of a feedback entry (owner action) */
export function setFeedbackStatus(
  id: number,
  status: 'open' | 'accepted' | 'rejected' | 'done',
): boolean {
  const result = updateFeedbackStatus.run(status, id);
  return result.changes > 0;
}

/** Upvote a feedback entry. Returns false if user already voted. */
export function upvoteFeedback(id: number, senderJid: string): boolean {
  const bare = senderJid.split('@')[0].split(':')[0];
  const entry = getFeedbackById(id);
  if (!entry) return false;

  const voters = JSON.parse(entry.upvoters) as string[];
  if (voters.includes(bare)) return false; // already voted

  voters.push(bare);
  updateFeedbackUpvote.run(entry.upvotes + 1, JSON.stringify(voters), id);
  return true;
}

// ── Public API: Memory (long-term community facts) ──────────────────

const insertMemory = db.prepare(`
  INSERT INTO memory (fact, category, source, created_at) VALUES (?, ?, ?, ?)
`);

const selectAllMemories = db.prepare(`
  SELECT * FROM memory ORDER BY category, created_at DESC
`);

const selectMemoriesByCategory = db.prepare(`
  SELECT * FROM memory WHERE category = ? ORDER BY created_at DESC
`);

const deleteMemoryById = db.prepare(`
  DELETE FROM memory WHERE id = ?
`);

const searchMemories = db.prepare(`
  SELECT * FROM memory WHERE fact LIKE ? ORDER BY created_at DESC LIMIT ?
`);

export interface MemoryEntry {
  id: number;
  fact: string;
  category: string;
  source: string;
  created_at: number;
}

/** Store a new community fact */
export function addMemory(fact: string, category: string = 'general', source: string = 'owner'): MemoryEntry {
  const ts = Math.floor(Date.now() / 1000);
  const result = insertMemory.run(fact, category, source, ts);
  return { id: Number(result.lastInsertRowid), fact, category, source, created_at: ts };
}

/** Get all stored memories */
export function getAllMemories(): MemoryEntry[] {
  return selectAllMemories.all() as MemoryEntry[];
}

/** Get memories by category */
export function getMemoriesByCategory(category: string): MemoryEntry[] {
  return selectMemoriesByCategory.all(category) as MemoryEntry[];
}

/** Delete a memory by ID */
export function deleteMemory(id: number): boolean {
  const result = deleteMemoryById.run(id);
  return result.changes > 0;
}

/** Search memories by keyword */
export function searchMemory(keyword: string, limit: number = 10): MemoryEntry[] {
  return searchMemories.all(`%${keyword}%`, limit) as MemoryEntry[];
}

/**
 * Format all memories as a context block for AI prompts.
 * Returns empty string if no memories stored.
 */
export function formatMemoriesForPrompt(): string {
  const memories = getAllMemories();
  if (memories.length === 0) return '';

  const byCategory = new Map<string, string[]>();
  for (const m of memories) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m.fact);
    byCategory.set(m.category, list);
  }

  const lines = ['Community knowledge (facts you know about this group):'];
  for (const [cat, facts] of byCategory) {
    lines.push(`  ${cat}:`);
    for (const f of facts) {
      lines.push(`    - ${f}`);
    }
  }
  return lines.join('\n');
}

// ── Public API: Member Profiles ─────────────────────────────────────

const upsertProfile = db.prepare(`
  INSERT INTO member_profiles (jid, first_seen, last_seen)
  VALUES (?, ?, ?)
  ON CONFLICT(jid) DO UPDATE SET last_seen = excluded.last_seen
`);

const selectProfile = db.prepare(`
  SELECT * FROM member_profiles WHERE jid = ?
`);

const updateProfileInterests = db.prepare(`
  UPDATE member_profiles SET interests = ?, opted_in = 1 WHERE jid = ?
`);

const updateProfileName = db.prepare(`
  UPDATE member_profiles SET name = ? WHERE jid = ?
`);

const updateProfileGroups = db.prepare(`
  UPDATE member_profiles SET groups_active = ? WHERE jid = ?
`);

const incrementEventCount = db.prepare(`
  UPDATE member_profiles SET event_count = event_count + 1 WHERE jid = ?
`);

const selectOptedInProfiles = db.prepare(`
  SELECT * FROM member_profiles WHERE opted_in = 1
`);

const deleteProfile = db.prepare(`
  DELETE FROM member_profiles WHERE jid = ?
`);

export interface MemberProfile {
  jid: string;
  name: string | null;
  interests: string; // JSON array of strings
  groups_active: string; // JSON array of group JIDs
  event_count: number;
  first_seen: number;
  last_seen: number;
  opted_in: number; // 0 or 1
}

/** Ensure a profile row exists for a member (called passively on every message) */
export function touchProfile(senderJid: string): void {
  const bare = senderJid.split('@')[0].split(':')[0];
  const now = Math.floor(Date.now() / 1000);
  upsertProfile.run(bare, now, now);
}

/** Get a member's profile, or undefined if not found */
export function getProfile(senderJid: string): MemberProfile | undefined {
  const bare = senderJid.split('@')[0].split(':')[0];
  return selectProfile.get(bare) as MemberProfile | undefined;
}

/** Set a member's interests (opt-in) */
export function setProfileInterests(senderJid: string, interests: string[]): void {
  const bare = senderJid.split('@')[0].split(':')[0];
  updateProfileInterests.run(JSON.stringify(interests), bare);
}

/** Set a member's display name */
export function setProfileName(senderJid: string, name: string): void {
  const bare = senderJid.split('@')[0].split(':')[0];
  updateProfileName.run(name, bare);
}

/** Update which groups a member is active in */
export function updateActiveGroups(senderJid: string, groupJid: string): void {
  const bare = senderJid.split('@')[0].split(':')[0];
  const profile = selectProfile.get(bare) as MemberProfile | undefined;
  if (!profile) return;

  const groups = JSON.parse(profile.groups_active) as string[];
  if (!groups.includes(groupJid)) {
    groups.push(groupJid);
    updateProfileGroups.run(JSON.stringify(groups), bare);
  }
}

/** Increment a member's event attendance count */
export function recordEventAttendance(senderJid: string): void {
  const bare = senderJid.split('@')[0].split(':')[0];
  incrementEventCount.run(bare);
}

/** Get all opted-in profiles */
export function getOptedInProfiles(): MemberProfile[] {
  return selectOptedInProfiles.all() as MemberProfile[];
}

/** Delete a member's profile (opt-out) */
export function deleteProfileData(senderJid: string): void {
  const bare = senderJid.split('@')[0].split(':')[0];
  deleteProfile.run(bare);
}

// ── Automated backup ────────────────────────────────────────────────

const BACKUP_DIR = resolve(DB_DIR, 'backups');
const MAX_BACKUPS = 7;

/**
 * Create a backup of the database file.
 * Uses SQLite's VACUUM INTO for a consistent snapshot (WAL-safe).
 * Keeps the last 7 daily backups, prunes older ones.
 */
export function backupDatabase(): string {
  mkdirSync(BACKUP_DIR, { recursive: true });

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const backupPath = resolve(BACKUP_DIR, `garbanzo-${dateStr}.db`);

  try {
    // VACUUM INTO creates a clean, consistent copy even with WAL mode
    db.exec(`VACUUM INTO '${backupPath}'`);
    logger.info({ backupPath }, 'Database backup created');
  } catch {
    // Fallback to file copy if VACUUM INTO is not supported
    copyFileSync(DB_PATH, backupPath);
    logger.info({ backupPath, method: 'filecopy' }, 'Database backup created (fallback)');
  }

  // Prune old backups beyond retention limit
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('garbanzo-') && f.endsWith('.db'))
      .sort()
      .reverse();

    for (const file of files.slice(MAX_BACKUPS)) {
      unlinkSync(resolve(BACKUP_DIR, file));
      logger.info({ file }, 'Old backup pruned');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to prune old backups');
  }

  return backupPath;
}

// ── Scheduled maintenance (auto-vacuum) ─────────────────────────────

/** Max age for messages in days. Older messages are pruned during vacuum. */
const MESSAGE_RETENTION_DAYS = 30;

const pruneOldByAge = db.prepare(`
  DELETE FROM messages WHERE timestamp < ?
`);

const countMessages = db.prepare(`
  SELECT COUNT(*) as count FROM messages
`);

/**
 * Prune messages older than 30 days, then run VACUUM to reclaim space.
 * Returns stats about what was cleaned.
 */
export function runMaintenance(): { pruned: number; beforeCount: number; afterCount: number } {
  const beforeCount = (countMessages.get() as { count: number }).count;
  const cutoff = Math.floor(Date.now() / 1000) - (MESSAGE_RETENTION_DAYS * 24 * 60 * 60);

  const result = pruneOldByAge.run(cutoff);
  const pruned = result.changes;

  // Only VACUUM if we actually deleted something (VACUUM is expensive)
  if (pruned > 0) {
    db.exec('VACUUM');
  }

  const afterCount = (countMessages.get() as { count: number }).count;

  logger.info({
    pruned,
    beforeCount,
    afterCount,
    retentionDays: MESSAGE_RETENTION_DAYS,
  }, 'Database maintenance complete');

  return { pruned, beforeCount, afterCount };
}

let maintenanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule daily maintenance at 4 AM local time.
 * Runs once when called, then reschedules itself for the next 4 AM.
 */
export function scheduleMaintenance(): void {
  const now = new Date();
  const next4AM = new Date(now);
  next4AM.setHours(4, 0, 0, 0);

  // If it's already past 4 AM today, schedule for tomorrow
  if (now >= next4AM) {
    next4AM.setDate(next4AM.getDate() + 1);
  }

  const msUntil = next4AM.getTime() - now.getTime();

  maintenanceTimer = setTimeout(() => {
    try {
      backupDatabase();
    } catch (err) {
      logger.error({ err }, 'Database backup failed');
    }
    try {
      runMaintenance();
    } catch (err) {
      logger.error({ err }, 'Database maintenance failed');
    }
    // Reschedule for next day
    scheduleMaintenance();
  }, msUntil);

  logger.info({
    nextRun: next4AM.toISOString(),
    inHours: +(msUntil / 3_600_000).toFixed(1),
  }, 'Database maintenance scheduled');
}

export function stopMaintenance(): void {
  if (maintenanceTimer) {
    clearTimeout(maintenanceTimer);
    maintenanceTimer = null;
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────

export function closeDb(): void {
  stopMaintenance();
  db.close();
  logger.info('SQLite database closed');
}
