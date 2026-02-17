/**
 * SQLite persistent storage — barrel module that re-exports all database
 * functionality from sub-modules and contains message, moderation, strike,
 * daily stats, feedback, and memory queries.
 */

import { db, closeDbHandle } from './db-schema.js';
import { stopMaintenance } from './db-maintenance.js';
import type { DbBackend } from './db-backend.js';
import type {
  DailyGroupActivity,
  DbMessage,
  FeedbackEntry,
  MemoryEntry,
  ModerationEntry,
  StrikeSummary,
} from './db-types.js';

// ── Re-export sub-modules ───────────────────────────────────────────

// Do not export the raw SQLite handle from the backend-facing API.
// Callers should import from `src/utils/db.ts` and use exported functions.
import {
  touchProfile,
  getProfile,
  setProfileInterests,
  setProfileName,
  updateActiveGroups,
  getOptedInProfiles,
  deleteProfileData,
} from './db-profiles.js';
import {
  backupDatabase,
  runMaintenance,
  verifyLatestBackupIntegrity,
  scheduleMaintenance,
} from './db-maintenance.js';

export {
  touchProfile,
  getProfile,
  setProfileInterests,
  setProfileName,
  updateActiveGroups,
  getOptedInProfiles,
  deleteProfileData,
};

export {
  backupDatabase,
  runMaintenance,
  verifyLatestBackupIntegrity,
  scheduleMaintenance,
  stopMaintenance,
  type BackupIntegrityStatus,
} from './db-maintenance.js';
export type {
  DailyGroupActivity,
  DbMessage,
  FeedbackEntry,
  MemberProfile,
  MemoryEntry,
  ModerationEntry,
  StrikeSummary,
} from './db-types.js';

// ── Prepared statements ─────────────────────────────────────────────

const insertMessage = db.prepare(
  `INSERT INTO messages (chat_jid, sender, text, timestamp) VALUES (?, ?, ?, ?)`,
);
const selectRecentMessages = db.prepare(
  `SELECT sender, text, timestamp FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC, id DESC LIMIT ?`,
);
const selectRelevantMessagesByKeyword = db.prepare(
  `SELECT sender, text, timestamp
   FROM messages
   WHERE chat_jid = ? AND text LIKE ?
   ORDER BY timestamp DESC, id DESC
   LIMIT ?`,
);
const pruneOldMessages = db.prepare(
  `DELETE FROM messages WHERE chat_jid = ? AND id NOT IN (SELECT id FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC, id DESC LIMIT ?)`,
);
const insertModerationLog = db.prepare(
  `INSERT INTO moderation_log (chat_jid, sender, text, reason, severity, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const upsertDailyStats = db.prepare(
  `INSERT INTO daily_stats (date, data) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET data = excluded.data`,
);
const selectDailyGroupMessages = db.prepare(
  `SELECT chat_jid as chatJid, COUNT(*) as messageCount, COUNT(DISTINCT sender) as activeUsers
   FROM messages
   WHERE timestamp >= ? AND timestamp <= ?
   GROUP BY chat_jid
   ORDER BY messageCount DESC`,
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
const MAX_MESSAGES_PER_CHAT = 5000;

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

/**
 * Lightweight relevance search for sqlite mode.
 *
 * sqlite does not have pgvector, so we do a keyword fallback using LIKE.
 */
export function searchRelevantMessages(chatJid: string, query: string, limit: number = 6): DbMessage[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];

  const tokens = Array.from(new Set(trimmed.split(/\s+/).filter((token) => token.length >= 3))).slice(0, 4);
  const terms = tokens.length > 0 ? tokens : [trimmed];

  const seen = new Set<string>();
  const matches: DbMessage[] = [];

  for (const term of terms) {
    const rows = selectRelevantMessagesByKeyword.all(chatJid, `%${term}%`, limit) as DbMessage[];
    for (const row of rows) {
      const key = `${row.timestamp}:${row.sender}:${row.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(row);
      if (matches.length >= limit) return matches;
    }
  }

  return matches;
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

/**
 * Get per-group activity counts from stored messages for a local calendar date.
 * Used as a digest fallback so restarts don't zero out message volume.
 */
export function getDailyGroupActivity(date: string): DailyGroupActivity[] {
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) return [];

  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day, 23, 59, 59, 999);

  return selectDailyGroupMessages.all(
    Math.floor(start.getTime() / 1000),
    Math.floor(end.getTime() / 1000),
  ) as DailyGroupActivity[];
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

/** Build a DbBackend contract from current sqlite functions. */
export function createSqliteBackend(): DbBackend {
  return {
    touchProfile: async (senderJid: string): Promise<void> => {
      touchProfile(senderJid);
    },
    getProfile: async (senderJid: string) => getProfile(senderJid),
    setProfileInterests: async (senderJid: string, interests: string[]): Promise<void> => {
      setProfileInterests(senderJid, interests);
    },
    setProfileName: async (senderJid: string, name: string): Promise<void> => {
      setProfileName(senderJid, name);
    },
    updateActiveGroups: async (senderJid: string, groupJid: string): Promise<void> => {
      updateActiveGroups(senderJid, groupJid);
    },
    getOptedInProfiles: async () => getOptedInProfiles(),
    deleteProfileData: async (senderJid: string): Promise<void> => {
      deleteProfileData(senderJid);
    },

    backupDatabase: async () => backupDatabase(),
    runMaintenance: async () => runMaintenance(),
    verifyLatestBackupIntegrity: async () => verifyLatestBackupIntegrity(),
    scheduleMaintenance,
    stopMaintenance,

    storeMessage: async (chatJid: string, sender: string, text: string): Promise<void> => {
      storeMessage(chatJid, sender, text);
    },
    getMessages: async (chatJid: string, limit?: number) => getMessages(chatJid, limit),
    searchRelevantMessages: async (chatJid: string, query: string, limit?: number) =>
      searchRelevantMessages(chatJid, query, limit),

    logModeration: async (entry: ModerationEntry): Promise<void> => {
      logModeration(entry);
    },
    getStrikeCount: async (senderJid: string) => getStrikeCount(senderJid),
    getRepeatOffenders: async (minStrikes?: number) => getRepeatOffenders(minStrikes),

    saveDailyStats: async (date: string, data: string): Promise<void> => {
      saveDailyStats(date, data);
    },
    getDailyGroupActivity: async (date: string) => getDailyGroupActivity(date),

    submitFeedback: async (
      type: 'suggestion' | 'bug',
      sender: string,
      groupJid: string | null,
      text: string,
    ) => submitFeedback(type, sender, groupJid, text),
    getOpenFeedback: async () => getOpenFeedback(),
    getRecentFeedback: async (limit?: number) => getRecentFeedback(limit),
    getFeedbackById: async (id: number) => getFeedbackById(id),
    setFeedbackStatus: async (
      id: number,
      status: 'open' | 'accepted' | 'rejected' | 'done',
    ) => setFeedbackStatus(id, status),
    upvoteFeedback: async (id: number, senderJid: string) => upvoteFeedback(id, senderJid),
    linkFeedbackToGitHubIssue: async (id: number, issueNumber: number, issueUrl: string) =>
      linkFeedbackToGitHubIssue(id, issueNumber, issueUrl),

    addMemory: async (fact: string, category?: string, source?: string) =>
      addMemory(fact, category, source),
    getAllMemories: async () => getAllMemories(),
    deleteMemory: async (id: number) => deleteMemory(id),
    searchMemory: async (keyword: string, limit?: number) => searchMemory(keyword, limit),
    formatMemoriesForPrompt: async () => formatMemoriesForPrompt(),

    closeDb: async (): Promise<void> => {
      closeDb();
    },
  };
}
