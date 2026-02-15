/**
 * SQLite persistent storage — barrel module that re-exports all database
 * functionality from sub-modules and contains message, moderation, strike,
 * daily stats, feedback, and memory queries.
 */

import { db, closeDbHandle } from './db-schema.js';
import { stopMaintenance } from './db-maintenance.js';

// ── Re-export sub-modules ───────────────────────────────────────────

export { db } from './db-schema.js';
export {
  touchProfile, getProfile, setProfileInterests, setProfileName,
  updateActiveGroups, getOptedInProfiles,
  deleteProfileData, type MemberProfile,
} from './db-profiles.js';
export {
  backupDatabase,
  runMaintenance,
  verifyLatestBackupIntegrity,
  scheduleMaintenance,
  stopMaintenance,
  type BackupIntegrityStatus,
} from './db-maintenance.js';

// ── Prepared statements ─────────────────────────────────────────────

const insertMessage = db.prepare(
  `INSERT INTO messages (chat_jid, sender, text, timestamp) VALUES (?, ?, ?, ?)`,
);
const selectRecentMessages = db.prepare(
  `SELECT sender, text, timestamp FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?`,
);
const pruneOldMessages = db.prepare(
  `DELETE FROM messages WHERE chat_jid = ? AND id NOT IN (SELECT id FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?)`,
);
const insertModerationLog = db.prepare(
  `INSERT INTO moderation_log (chat_jid, sender, text, reason, severity, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const upsertDailyStats = db.prepare(
  `INSERT INTO daily_stats (date, data) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET data = excluded.data`,
);
const countStrikesBySender = db.prepare(
  `SELECT COUNT(*) as count FROM moderation_log WHERE sender = ?`,
);
const selectRepeatOffenders = db.prepare(
  `SELECT sender, COUNT(*) as strike_count, MAX(timestamp) as last_flag, GROUP_CONCAT(DISTINCT reason) as reasons FROM moderation_log GROUP BY sender HAVING strike_count >= ? ORDER BY strike_count DESC`,
);
const insertFeedback = db.prepare(
  `INSERT INTO feedback (type, sender, group_jid, text, status, upvotes, upvoters, timestamp) VALUES (?, ?, ?, ?, 'open', 0, '[]', ?)`,
);
const selectOpenFeedback = db.prepare(
  `SELECT * FROM feedback WHERE status = 'open' ORDER BY upvotes DESC, timestamp ASC`,
);
const selectAllFeedback = db.prepare(
  `SELECT * FROM feedback ORDER BY timestamp DESC LIMIT ?`,
);
const selectFeedbackById = db.prepare(`SELECT * FROM feedback WHERE id = ?`);
const updateFeedbackStatus = db.prepare(`UPDATE feedback SET status = ? WHERE id = ?`);
const updateFeedbackUpvote = db.prepare(`UPDATE feedback SET upvotes = ?, upvoters = ? WHERE id = ?`);
const updateFeedbackGitHubIssue = db.prepare(
  `UPDATE feedback SET github_issue_number = ?, github_issue_url = ?, github_issue_created_at = ? WHERE id = ?`,
);
const insertMemory = db.prepare(
  `INSERT INTO memory (fact, category, source, created_at) VALUES (?, ?, ?, ?)`,
);
const selectAllMemories = db.prepare(`SELECT * FROM memory ORDER BY category, created_at DESC`);
const deleteMemoryById = db.prepare(`DELETE FROM memory WHERE id = ?`);
const searchMemories = db.prepare(`SELECT * FROM memory WHERE fact LIKE ? ORDER BY created_at DESC LIMIT ?`);

// ── Types ───────────────────────────────────────────────────────────

/** Max messages kept per chat in the database */
const MAX_MESSAGES_PER_CHAT = 100;

export interface DbMessage {
  sender: string;
  text: string;
  timestamp: number;
}

export interface ModerationEntry {
  chatJid: string;
  sender: string;
  text: string;
  reason: string;
  severity: string;
  source: string;
  timestamp: number;
}

export interface StrikeSummary {
  sender: string;
  strike_count: number;
  last_flag: number;
  reasons: string;
}

export interface FeedbackEntry {
  id: number;
  type: 'suggestion' | 'bug';
  sender: string;
  group_jid: string | null;
  text: string;
  status: 'open' | 'accepted' | 'rejected' | 'done';
  upvotes: number;
  upvoters: string;
  github_issue_number: number | null;
  github_issue_url: string | null;
  github_issue_created_at: number | null;
  timestamp: number;
}

export interface MemoryEntry {
  id: number;
  fact: string;
  category: string;
  source: string;
  created_at: number;
}

// ── Public API: Messages ────────────────────────────────────────────

/** Store a message and prune old ones beyond the limit. */
export function storeMessage(chatJid: string, sender: string, text: string): void {
  const bare = sender.split('@')[0].split(':')[0];
  const truncated = text.length > 500 ? text.slice(0, 497) + '...' : text;
  const ts = Math.floor(Date.now() / 1000);
  insertMessage.run(chatJid, bare, truncated, ts);
  pruneOldMessages.run(chatJid, chatJid, MAX_MESSAGES_PER_CHAT);
}

/** Get recent messages for a chat (returned oldest-first for prompt context). */
export function getMessages(chatJid: string, limit: number = 15): DbMessage[] {
  const rows = selectRecentMessages.all(chatJid, limit) as DbMessage[];
  return rows.reverse();
}

// ── Public API: Moderation ──────────────────────────────────────────

/** Persist a moderation flag entry for strikes/audit history. */
export function logModeration(entry: ModerationEntry): void {
  insertModerationLog.run(
    entry.chatJid, entry.sender, entry.text,
    entry.reason, entry.severity, entry.source, entry.timestamp,
  );
}

// ── Public API: Strikes ─────────────────────────────────────────────

/** Get total strike count for a sender (bare JID) */
export function getStrikeCount(senderJid: string): number {
  const bare = senderJid.split('@')[0].split(':')[0];
  return (countStrikesBySender.get(bare) as { count: number }).count;
}

/** Get all users with N+ strikes */
export function getRepeatOffenders(minStrikes: number = 3): StrikeSummary[] {
  return selectRepeatOffenders.all(minStrikes) as StrikeSummary[];
}

// ── Public API: Daily Stats ─────────────────────────────────────────

/** Persist serialized daily stats snapshot by date. */
export function saveDailyStats(date: string, data: string): void {
  upsertDailyStats.run(date, data);
}

// ── Public API: Feedback ────────────────────────────────────────────

/** Submit a new feature suggestion or bug report */
export function submitFeedback(
  type: 'suggestion' | 'bug', sender: string, groupJid: string | null, text: string,
): FeedbackEntry {
  const bare = sender.split('@')[0].split(':')[0];
  const ts = Math.floor(Date.now() / 1000);
  const result = insertFeedback.run(type, bare, groupJid, text, ts);
  return {
    id: Number(result.lastInsertRowid), type, sender: bare,
    group_jid: groupJid,
    text,
    status: 'open',
    upvotes: 0,
    upvoters: '[]',
    github_issue_number: null,
    github_issue_url: null,
    github_issue_created_at: null,
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
  id: number, status: 'open' | 'accepted' | 'rejected' | 'done',
): boolean {
  return updateFeedbackStatus.run(status, id).changes > 0;
}

/** Upvote a feedback entry. Returns false if user already voted. */
export function upvoteFeedback(id: number, senderJid: string): boolean {
  const bare = senderJid.split('@')[0].split(':')[0];
  const entry = getFeedbackById(id);
  if (!entry) return false;
  const voters = JSON.parse(entry.upvoters) as string[];
  if (voters.includes(bare)) return false;
  voters.push(bare);
  updateFeedbackUpvote.run(entry.upvotes + 1, JSON.stringify(voters), id);
  return true;
}

/** Link a feedback entry to a created GitHub issue. */
export function linkFeedbackToGitHubIssue(
  id: number,
  issueNumber: number,
  issueUrl: string,
): boolean {
  const ts = Math.floor(Date.now() / 1000);
  return updateFeedbackGitHubIssue.run(issueNumber, issueUrl, ts, id).changes > 0;
}

// ── Public API: Memory ──────────────────────────────────────────────

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

/** Delete a memory by ID */
export function deleteMemory(id: number): boolean {
  return deleteMemoryById.run(id).changes > 0;
}

/** Search memories by keyword */
export function searchMemory(keyword: string, limit: number = 10): MemoryEntry[] {
  return searchMemories.all(`%${keyword}%`, limit) as MemoryEntry[];
}

/** Format all memories as a context block for AI prompts. */
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
    for (const f of facts) lines.push(`    - ${f}`);
  }
  return lines.join('\n');
}

// ── Cleanup ─────────────────────────────────────────────────────────

/** Stop scheduled maintenance and close SQLite handle for shutdown. */
export function closeDb(): void {
  stopMaintenance();
  closeDbHandle();
}
