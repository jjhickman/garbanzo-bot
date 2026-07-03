/**
 * SQLite persistent storage — barrel module that re-exports all database
 * functionality from sub-modules and contains message, moderation, strike,
 * daily stats, feedback, and memory queries.
 */

import { db, closeDbHandle } from './db-schema.js';
import { stopMaintenance } from './db-maintenance.js';
import { logger } from '../middleware/logger.js';
import { config } from './config.js';
import { recordSessionSummaryLifecycle } from '../middleware/stats.js';
import { summarizeSession, scoreSessionMatch, buildContextualizedEmbeddingInput } from './session-summary.js';
import { indexSession } from './vector-memory.js';
import type { DbBackend } from './db-backend.js';
import {
  mapDailyGroupActivity,
  mapDbMessage,
  mapEventReminder,
  mapFeedbackEntry,
  mapMemoryEntry,
  mapSessionSummaryHit,
  mapStrikeSummary,
  mapWhatsAppOutboundJob,
  mapWhatsAppSafetyState,
  type DailyGroupActivityRow,
  type EventReminderRow,
  type FeedbackRow,
  type MemoryRow,
  type MessageRow,
  type SessionSummaryRow,
  type StrikeSummaryRow,
  type WhatsAppOutboundRow,
  type WhatsAppSafetyStateRow,
} from './db-mappers.js';
import {
  appendUniqueJsonArrayItem,
  extractSearchTerms,
  formatMemoriesForPromptEntries,
  mapWhatsAppSafetyMetrics,
  parseJsonArray,
  toBareJid,
  toNumber,
  type WhatsAppMetricCountsLike,
} from './db-query-shape.js';
import type {
  DailyGroupActivity,
  DbMessage,
  EventReminder,
  FeedbackEntry,
  MemoryEntry,
  ModerationEntry,
  NewEventReminder,
  SessionSummaryHit,
  StrikeSummary,
  WhatsAppOutboundJob,
  WhatsAppOutboundStatus,
  WhatsAppRiskLevel,
  WhatsAppSafetyMetrics,
  WhatsAppSafetyState,
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
  SessionSummaryHit,
  StrikeSummary,
  WhatsAppOutboundJob,
  WhatsAppOutboundStatus,
  WhatsAppRiskLevel,
  WhatsAppSafetyMetrics,
  WhatsAppSafetyState,
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
const selectOpenSession = db.prepare(
  `SELECT id, started_at, ended_at, message_count, participants
   FROM conversation_sessions
   WHERE chat_jid = ? AND status = 'open'
   ORDER BY ended_at DESC, id DESC
   LIMIT 1`,
);
const insertOpenSession = db.prepare(
  `INSERT INTO conversation_sessions
   (chat_jid, started_at, ended_at, message_count, participants, status)
   VALUES (?, ?, ?, ?, ?, 'open')`,
);
const updateOpenSession = db.prepare(
  `UPDATE conversation_sessions
   SET ended_at = ?, message_count = ?, participants = ?
   WHERE id = ?`,
);
const updateSessionSummary = db.prepare(
  `UPDATE conversation_sessions
   SET status = ?, summary_text = ?, topic_tags = ?, summary_version = ?, summary_created_at = ?
   WHERE id = ?`,
);
const selectMessagesInWindow = db.prepare(
  `SELECT sender, text, timestamp FROM messages
   WHERE chat_jid = ? AND timestamp >= ? AND timestamp <= ?
   ORDER BY timestamp ASC, id ASC
   LIMIT ?`,
);
const selectSessionSummaryCandidates = db.prepare(
  `SELECT id, started_at, ended_at, message_count, participants, summary_text, topic_tags
   FROM conversation_sessions
   WHERE chat_jid = ? AND status = 'summarized' AND summary_text IS NOT NULL
   ORDER BY ended_at DESC, id DESC
   LIMIT ?`,
);
const insertModerationLog = db.prepare(
  `INSERT INTO moderation_log (chat_jid, sender, text, reason, severity, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const upsertDailyStats = db.prepare(
  `INSERT INTO daily_stats (date, data) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET data = excluded.data`,
);
const selectDailyStatsRange = db.prepare(
  `SELECT date, data FROM daily_stats WHERE date >= ? AND date <= ? ORDER BY date ASC`,
);
const selectDailyGroupMessages = db.prepare(
  `SELECT chat_jid as chatJid, COUNT(*) as messageCount, COUNT(DISTINCT sender) as activeUsers
   FROM messages
   WHERE timestamp >= ? AND timestamp <= ?
   GROUP BY chat_jid
   ORDER BY messageCount DESC`,
);
const insertEventReminder = db.prepare(
  `INSERT INTO event_reminders
   (chat_jid, activity, location, event_at, remind_at, created_by, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
);
const selectEventReminderById = db.prepare(`SELECT * FROM event_reminders WHERE id = ?`);
const selectPendingEventReminders = db.prepare(
  `SELECT * FROM event_reminders
   WHERE status = 'pending' AND remind_at <= ?
   ORDER BY remind_at ASC, id ASC`,
);
const selectUpcomingEventReminders = db.prepare(
  `SELECT * FROM event_reminders
   WHERE status = 'pending' AND event_at >= ?
   ORDER BY event_at ASC, id ASC
   LIMIT ?`,
);
const updateEventReminderSent = db.prepare(
  `UPDATE event_reminders SET status = 'sent' WHERE id = ? AND status = 'pending'`,
);
const updateEventReminderCancelled = db.prepare(
  `UPDATE event_reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`,
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
const insertWhatsAppOutboundJob = db.prepare(
  `INSERT INTO whatsapp_outbound_jobs
   (chat_jid, kind, content_json, options_json, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
);
const selectWhatsAppOutboundJob = db.prepare(`SELECT * FROM whatsapp_outbound_jobs WHERE id = ?`);
const selectWhatsAppHeldJobs = db.prepare(
  `SELECT * FROM whatsapp_outbound_jobs WHERE status = 'held' ORDER BY created_at ASC, id ASC LIMIT ?`,
);
const updateWhatsAppOutboundStatus = db.prepare(
  `UPDATE whatsapp_outbound_jobs
   SET status = ?, reason = ?, attempts = attempts + 1, updated_at = ?, sent_at = ?
   WHERE id = ?`,
);
const recoverWhatsAppPending = db.prepare(
  `UPDATE whatsapp_outbound_jobs SET status = 'held', reason = ?, updated_at = ? WHERE status = 'pending'`,
);
const countWhatsAppSent = db.prepare(
  `SELECT COUNT(*) AS count FROM whatsapp_outbound_jobs WHERE status = 'sent' AND sent_at >= ?`,
);
const selectWhatsAppSafetyState = db.prepare(`SELECT * FROM whatsapp_safety_state WHERE id = 1`);
const upsertWhatsAppSafetyState = db.prepare(
  `INSERT INTO whatsapp_safety_state (id, paused, risk, score, reasons, updated_at)
   VALUES (1, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     paused = excluded.paused,
     risk = excluded.risk,
     score = excluded.score,
     reasons = excluded.reasons,
     updated_at = excluded.updated_at`,
);
const selectWhatsAppMetricCounts = db.prepare(
  `SELECT
     SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
     SUM(CASE WHEN status = 'held' THEN 1 ELSE 0 END) AS held,
     SUM(CASE WHEN status = 'sent' AND sent_at >= ? THEN 1 ELSE 0 END) AS sentLastHour,
     SUM(CASE WHEN status = 'sent' AND sent_at >= ? THEN 1 ELSE 0 END) AS sentLastDay,
     SUM(CASE WHEN status = 'failed' AND updated_at >= ? THEN 1 ELSE 0 END) AS failedLastHour
   FROM whatsapp_outbound_jobs`,
);

// ── Types ───────────────────────────────────────────────────────────

/** Max messages kept per chat in the database */
const MAX_MESSAGES_PER_CHAT = 5000;
const SESSION_FETCH_LIMIT = 160;

interface OpenSessionRow {
  id: number;
  started_at: number;
  ended_at: number;
  message_count: number;
  participants: string;
}

function finalizeSessionSummary(chatJid: string, session: OpenSessionRow): void {
  const summaryCreatedAt = Math.floor(Date.now() / 1000);

  if (session.message_count < config.CONTEXT_SESSION_MIN_MESSAGES) {
    updateSessionSummary.run('closed', null, '[]', config.CONTEXT_SESSION_SUMMARY_VERSION, summaryCreatedAt, session.id);
    recordSessionSummaryLifecycle(chatJid, 'skipped');
    return;
  }

  const sessionMessages = selectMessagesInWindow.all(
    chatJid,
    session.started_at,
    session.ended_at,
    SESSION_FETCH_LIMIT,
  ) as MessageRow[];

  if (sessionMessages.length < config.CONTEXT_SESSION_MIN_MESSAGES) {
    updateSessionSummary.run('closed', null, '[]', config.CONTEXT_SESSION_SUMMARY_VERSION, summaryCreatedAt, session.id);
    recordSessionSummaryLifecycle(chatJid, 'skipped');
    return;
  }

  const participants = parseJsonArray(session.participants);
  const summary = summarizeSession(sessionMessages.map(mapDbMessage), participants);

  updateSessionSummary.run(
    'summarized',
    summary.summaryText,
    JSON.stringify(summary.topicTags),
    config.CONTEXT_SESSION_SUMMARY_VERSION,
    summaryCreatedAt,
    session.id,
  );
  recordSessionSummaryLifecycle(chatJid, 'created');
  void indexSession({
    chatJid,
    refId: String(session.id),
    embeddingInput: buildContextualizedEmbeddingInput(summary.summaryText, {
      chatJid,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      participants,
      topicTags: summary.topicTags,
    }),
    summaryText: summary.summaryText,
    createdAt: session.ended_at,
    extra: { topics: summary.topicTags, timeRange: [session.started_at, session.ended_at] },
  }).catch((err) => logger.warn({ err }, 'session vector index failed'));
}

function upsertConversationSession(chatJid: string, sender: string, timestamp: number): void {
  if (!config.CONTEXT_SESSION_MEMORY_ENABLED) return;

  try {
    const openSession = selectOpenSession.get(chatJid) as OpenSessionRow | undefined;
    const gapSeconds = config.CONTEXT_SESSION_GAP_MINUTES * 60;
    const participantsJson = JSON.stringify([sender]);

    if (!openSession) {
      insertOpenSession.run(chatJid, timestamp, timestamp, 1, participantsJson);
      return;
    }

    if (timestamp - openSession.ended_at <= gapSeconds) {
      const updatedParticipants = appendUniqueJsonArrayItem(openSession.participants, sender);
      updateOpenSession.run(timestamp, openSession.message_count + 1, updatedParticipants, openSession.id);
      return;
    }

    finalizeSessionSummary(chatJid, openSession);
    insertOpenSession.run(chatJid, timestamp, timestamp, 1, participantsJson);
  } catch (err) {
    recordSessionSummaryLifecycle(chatJid, 'failed');
    logger.warn({ err, chatJid }, 'Session summary update failed');
  }
}

// ── Public API: Messages ────────────────────────────────────────────

/** Store a message and prune old ones beyond the limit. */
export function storeMessage(chatJid: string, sender: string, text: string): number {
  const bare = toBareJid(sender);
  const truncated = text.length > 500 ? text.slice(0, 497) + '...' : text;
  const ts = Math.floor(Date.now() / 1000);
  insertMessage.run(chatJid, bare, truncated, ts);
  pruneOldMessages.run(chatJid, chatJid, MAX_MESSAGES_PER_CHAT);
  upsertConversationSession(chatJid, bare, ts);
  return ts;
}

/** Get recent messages for a chat (returned oldest-first for prompt context). */
export function getMessages(chatJid: string, limit: number = 15): DbMessage[] {
  const rows = selectRecentMessages.all(chatJid, limit) as MessageRow[];
  return rows.map(mapDbMessage).reverse();
}

/**
 * Lightweight relevance search for sqlite mode.
 *
 * sqlite does not have pgvector, so we do a keyword fallback using LIKE.
 */
export function searchRelevantMessages(chatJid: string, query: string, limit: number = 6): DbMessage[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];

  const tokens = extractSearchTerms(trimmed, 4);
  const terms = tokens.length > 0 ? tokens : [trimmed];

  const seen = new Set<string>();
  const matches: DbMessage[] = [];

  for (const term of terms) {
    const rows = selectRelevantMessagesByKeyword.all(chatJid, `%${term}%`, limit) as MessageRow[];
    for (const row of rows) {
      const mapped = mapDbMessage(row);
      const key = `${mapped.timestamp}:${mapped.sender}:${mapped.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(mapped);
      if (matches.length >= limit) return matches;
    }
  }

  return matches;
}

export function searchRelevantSessionSummaries(
  chatJid: string,
  query: string,
  limit: number = config.CONTEXT_SESSION_MAX_RETRIEVED,
): SessionSummaryHit[] {
  if (!config.CONTEXT_SESSION_MEMORY_ENABLED) return [];

  const trimmed = query.trim();
  if (!trimmed) return [];

  const candidates = selectSessionSummaryCandidates.all(chatJid, Math.max(limit * 4, 12)) as SessionSummaryRow[];

  const scored = candidates
    .map((row) => {
      const topicTags = parseJsonArray(row.topic_tags);
      const summaryText = row.summary_text;
      return mapSessionSummaryHit(row, scoreSessionMatch(summaryText, topicTags, trimmed, toNumber(row.ended_at)));
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
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
  const bare = toBareJid(senderJid);
  return toNumber((countStrikesBySender.get(bare) as { count: number }).count);
}

/** Get all users with N+ strikes */
export function getRepeatOffenders(minStrikes: number = 3): StrikeSummary[] {
  return (selectRepeatOffenders.all(minStrikes) as StrikeSummaryRow[]).map(mapStrikeSummary);
}

// ── Public API: Daily Stats ─────────────────────────────────────────

/** Persist serialized daily stats snapshot by date. */
export function saveDailyStats(date: string, data: string): void {
  upsertDailyStats.run(date, data);
}

/** Archived daily stats snapshots within an inclusive ISO-date range. */
export function loadDailyStatsRange(fromDate: string, toDate: string): Array<{ date: string; data: string }> {
  return selectDailyStatsRange.all(fromDate, toDate) as Array<{ date: string; data: string }>;
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

  return (selectDailyGroupMessages.all(
    Math.floor(start.getTime() / 1000),
    Math.floor(end.getTime() / 1000),
  ) as DailyGroupActivityRow[]).map(mapDailyGroupActivity);
}

// ── Public API: Event Reminders ────────────────────────────────────

export function addEventReminder(input: NewEventReminder): EventReminder {
  const ts = Math.floor(Date.now() / 1000);
  const result = insertEventReminder.run(
    input.chatJid,
    input.activity,
    input.location,
    input.eventAt,
    input.remindAt,
    input.createdBy,
    ts,
  );
  return mapEventReminder(selectEventReminderById.get(result.lastInsertRowid) as EventReminderRow);
}

export function listPendingEventReminders(nowSeconds: number): EventReminder[] {
  return (selectPendingEventReminders.all(nowSeconds) as EventReminderRow[]).map(mapEventReminder);
}

export function listUpcomingEventReminders(limit: number = 20): EventReminder[] {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return (selectUpcomingEventReminders.all(nowSeconds, limit) as EventReminderRow[]).map(mapEventReminder);
}

export function markEventReminderSent(id: number): boolean {
  return updateEventReminderSent.run(id).changes > 0;
}

export function cancelEventReminder(id: number): boolean {
  return updateEventReminderCancelled.run(id).changes > 0;
}

// ── Public API: WhatsApp Safety ─────────────────────────────────────

export function createWhatsAppOutboundJob(
  chatJid: string,
  kind: string,
  contentJson: string,
  optionsJson: string | null,
): WhatsAppOutboundJob {
  const ts = Math.floor(Date.now() / 1000);
  const result = insertWhatsAppOutboundJob.run(chatJid, kind, contentJson, optionsJson, ts, ts);
  return mapWhatsAppOutboundJob(selectWhatsAppOutboundJob.get(result.lastInsertRowid) as WhatsAppOutboundRow);
}

export function updateWhatsAppOutboundJob(
  id: number,
  status: WhatsAppOutboundStatus,
  reason: string | null = null,
  sentAt: number | null = null,
): boolean {
  const ts = Math.floor(Date.now() / 1000);
  return updateWhatsAppOutboundStatus.run(status, reason, ts, sentAt, id).changes > 0;
}

export function getWhatsAppOutboundJob(id: number): WhatsAppOutboundJob | undefined {
  const row = selectWhatsAppOutboundJob.get(id) as WhatsAppOutboundRow | undefined;
  return row ? mapWhatsAppOutboundJob(row) : undefined;
}

export function listWhatsAppHeldJobs(limit: number = 20): WhatsAppOutboundJob[] {
  return (selectWhatsAppHeldJobs.all(limit) as WhatsAppOutboundRow[]).map(mapWhatsAppOutboundJob);
}

export function recoverWhatsAppPendingJobs(reason: string): number {
  const ts = Math.floor(Date.now() / 1000);
  return recoverWhatsAppPending.run(reason, ts).changes;
}

export function countWhatsAppSentSince(since: number): number {
  return toNumber((countWhatsAppSent.get(since) as { count: number }).count);
}

export function getWhatsAppSafetyState(): WhatsAppSafetyState {
  const row = selectWhatsAppSafetyState.get() as WhatsAppSafetyStateRow;
  return mapWhatsAppSafetyState(row);
}

export function setWhatsAppSafetyState(
  paused: boolean,
  risk: WhatsAppRiskLevel,
  score: number,
  reasons: string[],
): void {
  upsertWhatsAppSafetyState.run(paused ? 1 : 0, risk, score, JSON.stringify(reasons), Math.floor(Date.now() / 1000));
}

export function getWhatsAppSafetyMetrics(hourSince: number, daySince: number): WhatsAppSafetyMetrics {
  const counts = selectWhatsAppMetricCounts.get(hourSince, daySince, hourSince) as WhatsAppMetricCountsLike;
  const state = getWhatsAppSafetyState();
  return mapWhatsAppSafetyMetrics(counts, state);
}

// ── Public API: Feedback ────────────────────────────────────────────

/** Submit a new feature suggestion or bug report */
export function submitFeedback(
  type: 'suggestion' | 'bug', sender: string, groupJid: string | null, text: string,
): FeedbackEntry {
  const bare = toBareJid(sender);
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
  return (selectOpenFeedback.all() as FeedbackRow[]).map(mapFeedbackEntry);
}

/** Get recent feedback (any status) */
export function getRecentFeedback(limit: number = 20): FeedbackEntry[] {
  return (selectAllFeedback.all(limit) as FeedbackRow[]).map(mapFeedbackEntry);
}

/** Get a single feedback entry by ID */
export function getFeedbackById(id: number): FeedbackEntry | undefined {
  const row = selectFeedbackById.get(id) as FeedbackRow | undefined;
  return row ? mapFeedbackEntry(row) : undefined;
}

/** Update the status of a feedback entry (owner action) */
export function setFeedbackStatus(
  id: number, status: 'open' | 'accepted' | 'rejected' | 'done',
): boolean {
  return updateFeedbackStatus.run(status, id).changes > 0;
}

/** Upvote a feedback entry. Returns false if user already voted. */
export function upvoteFeedback(id: number, senderJid: string): boolean {
  const bare = toBareJid(senderJid);
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
  return (selectAllMemories.all() as MemoryRow[]).map(mapMemoryEntry);
}

/** Delete a memory by ID */
export function deleteMemory(id: number): boolean {
  return deleteMemoryById.run(id).changes > 0;
}

/** Search memories by keyword */
export function searchMemory(keyword: string, limit: number = 10): MemoryEntry[] {
  return (searchMemories.all(`%${keyword}%`, limit) as MemoryRow[]).map(mapMemoryEntry);
}

/** Format all memories as a context block for AI prompts. */
export function formatMemoriesForPrompt(): string {
  const memories = getAllMemories();
  return formatMemoriesForPromptEntries(memories);
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

    storeMessage: async (chatJid: string, sender: string, text: string): Promise<number> =>
      storeMessage(chatJid, sender, text),
    getMessages: async (chatJid: string, limit?: number) => getMessages(chatJid, limit),
    searchRelevantMessages: async (chatJid: string, query: string, limit?: number) =>
      searchRelevantMessages(chatJid, query, limit),
    searchRelevantSessionSummaries: async (chatJid: string, query: string, limit?: number) =>
      searchRelevantSessionSummaries(chatJid, query, limit),

    logModeration: async (entry: ModerationEntry): Promise<void> => {
      logModeration(entry);
    },
    getStrikeCount: async (senderJid: string) => getStrikeCount(senderJid),
    getRepeatOffenders: async (minStrikes?: number) => getRepeatOffenders(minStrikes),

    saveDailyStats: async (date: string, data: string): Promise<void> => {
      saveDailyStats(date, data);
    },
    loadDailyStatsRange: async (fromDate: string, toDate: string) => loadDailyStatsRange(fromDate, toDate),
    getDailyGroupActivity: async (date: string) => getDailyGroupActivity(date),

    addEventReminder: async (input: NewEventReminder) => addEventReminder(input),
    listPendingEventReminders: async (nowSeconds: number) => listPendingEventReminders(nowSeconds),
    listUpcomingEventReminders: async (limit?: number) => listUpcomingEventReminders(limit),
    markEventReminderSent: async (id: number) => markEventReminderSent(id),
    cancelEventReminder: async (id: number) => cancelEventReminder(id),

    createWhatsAppOutboundJob: async (chatJid: string, kind: string, contentJson: string, optionsJson: string | null) =>
      createWhatsAppOutboundJob(chatJid, kind, contentJson, optionsJson),
    updateWhatsAppOutboundJob: async (
      id: number,
      status: WhatsAppOutboundStatus,
      reason?: string | null,
      sentAt?: number | null,
    ) => updateWhatsAppOutboundJob(id, status, reason, sentAt),
    getWhatsAppOutboundJob: async (id: number) => getWhatsAppOutboundJob(id),
    listWhatsAppHeldJobs: async (limit?: number) => listWhatsAppHeldJobs(limit),
    recoverWhatsAppPendingJobs: async (reason: string) => recoverWhatsAppPendingJobs(reason),
    countWhatsAppSentSince: async (since: number) => countWhatsAppSentSince(since),
    getWhatsAppSafetyState: async () => getWhatsAppSafetyState(),
    setWhatsAppSafetyState: async (
      paused: boolean,
      risk: WhatsAppRiskLevel,
      score: number,
      reasons: string[],
    ): Promise<void> => {
      setWhatsAppSafetyState(paused, risk, score, reasons);
    },
    getWhatsAppSafetyMetrics: async (hourSince: number, daySince: number) =>
      getWhatsAppSafetyMetrics(hourSince, daySince),

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
