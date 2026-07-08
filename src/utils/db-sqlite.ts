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
import type { BridgeEnvelope } from '../bridge/envelope.js';
import { summarizeSession, scoreSessionMatch, buildContextualizedEmbeddingInput } from './session-summary.js';
import { indexSession } from './vector-memory.js';
import type { DbBackend } from './db-backend.js';
import {
  mapAvailability,
  mapBridgeBufferEntry,
  mapBridgeOutboxEntry,
  mapDailyGroupActivity,
  mapDbMessage,
  mapEventReminder,
  mapFeedbackEntry,
  mapMemoryEntry,
  mapRehearsal,
  mapSessionSummaryHit,
  mapSetlist,
  mapSetlistEntry,
  mapSetlistSong,
  mapSong,
  mapSongIdea,
  mapSongSection,
  mapStrikeSummary,
  mapWhatsAppOutboundJob,
  mapWhatsAppSafetyState,
  type AvailabilityRow,
  type BridgeBufferRow,
  type BridgeOutboxRow,
  type DailyGroupActivityRow,
  type EventReminderRow,
  type FeedbackRow,
  type MemoryRow,
  type MessageRow,
  type RehearsalRow,
  type SessionSummaryRow,
  type SetlistEntryRow,
  type SetlistRow,
  type SetlistSongRow,
  type SongIdeaRow,
  type SongRow,
  type SongSectionRow,
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
  Availability,
  AvailabilityResponse,
  BackfillSession,
  BridgeBufferEntry,
  BridgeOutboxCounts,
  BridgeOutboxEntry,
  DailyGroupActivity,
  DbMessage,
  EventReminder,
  FeedbackEntry,
  LocalMemoryEntry,
  MemoryEntry,
  ModerationEntry,
  NewEventReminder,
  Rehearsal,
  RehearsalStatus,
  SectionKind,
  SessionSummaryHit,
  Setlist,
  SetlistEntry,
  SetlistSong,
  Song,
  SongIdea,
  SongSection,
  SongStatus,
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
  Song,
  SongStatus,
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
const selectAllSummarizedSessions = db.prepare(
  `SELECT id, chat_jid, started_at, ended_at, message_count, participants, summary_text, topic_tags
   FROM conversation_sessions
   WHERE status = 'summarized' AND summary_text IS NOT NULL
   ORDER BY ended_at DESC, id DESC
   LIMIT ?`,
);
const selectDistinctMessageChats = db.prepare(
  `SELECT DISTINCT chat_jid FROM messages`,
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
const insertSong = db.prepare(
  `INSERT INTO songs (title, song_key, tempo, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const selectSongById = db.prepare(`SELECT * FROM songs WHERE id = ?`);
const selectSongByTitleLower = db.prepare(`SELECT * FROM songs WHERE lower(title) = lower(?)`);
const selectAllSongs = db.prepare(`SELECT * FROM songs ORDER BY title ASC`);
const selectSongsByStatus = db.prepare(`SELECT * FROM songs WHERE status = ? ORDER BY title ASC`);
const updateSongRow = db.prepare(
  `UPDATE songs SET title = ?, song_key = ?, tempo = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?`,
);
const deleteSongById = db.prepare(`DELETE FROM songs WHERE id = ?`);
const insertSongIdea = db.prepare(
  `INSERT INTO song_ideas (title, text, audio_url, transcript, song_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const selectSongIdeaById = db.prepare(`SELECT * FROM song_ideas WHERE id = ?`);
const selectSongIdeasNewestFirst = db.prepare(
  `SELECT * FROM song_ideas ORDER BY created_at DESC, id DESC`,
);
const selectSongIdeasNewestFirstLimited = db.prepare(
  `SELECT * FROM song_ideas ORDER BY created_at DESC, id DESC LIMIT ?`,
);
const updateSongIdeaSongId = db.prepare(`UPDATE song_ideas SET song_id = ? WHERE id = ?`);
const deleteSongIdeaById = db.prepare(`DELETE FROM song_ideas WHERE id = ?`);
const nullSongIdeasBySongId = db.prepare(`UPDATE song_ideas SET song_id = NULL WHERE song_id = ?`);
const insertSongSection = db.prepare(
  `INSERT INTO song_sections (song_id, kind, position, lyrics, chords, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const selectSongSectionById = db.prepare(`SELECT * FROM song_sections WHERE id = ?`);
const selectMaxSongSectionPosition = db.prepare(
  `SELECT MAX(position) AS maxPosition FROM song_sections WHERE song_id = ?`,
);
const selectSongSectionsOrdered = db.prepare(
  `SELECT * FROM song_sections WHERE song_id = ? ORDER BY position ASC`,
);
const updateSongSectionRow = db.prepare(
  `UPDATE song_sections SET kind = ?, lyrics = ?, chords = ?, updated_at = ? WHERE id = ?`,
);
const updateSongSectionPosition = db.prepare(`UPDATE song_sections SET position = ? WHERE id = ?`);
const deleteSongSectionById = db.prepare(`DELETE FROM song_sections WHERE id = ?`);
const deleteSongSectionsBySong = db.prepare(`DELETE FROM song_sections WHERE song_id = ?`);
const insertRehearsal = db.prepare(
  `INSERT INTO rehearsals (scheduled_at, location, agenda, status, reminder_sent, created_by, created_at, updated_at)
   VALUES (?, ?, ?, 'scheduled', 0, ?, ?, ?)`,
);
const selectRehearsalById = db.prepare(`SELECT * FROM rehearsals WHERE id = ?`);
const selectUpcomingRehearsals = db.prepare(
  `SELECT * FROM rehearsals
   WHERE status = 'scheduled' AND scheduled_at >= ?
   ORDER BY scheduled_at ASC
   LIMIT ?`,
);
const selectNextRehearsal = db.prepare(
  `SELECT * FROM rehearsals
   WHERE status = 'scheduled' AND scheduled_at >= ?
   ORDER BY scheduled_at ASC
   LIMIT 1`,
);
const updateRehearsalRow = db.prepare(
  `UPDATE rehearsals
   SET scheduled_at = ?, location = ?, agenda = ?, status = ?, updated_at = ?
   WHERE id = ?`,
);
const updateRehearsalCancelled = db.prepare(
  `UPDATE rehearsals SET status = 'cancelled', updated_at = ? WHERE id = ?`,
);
const selectRehearsalsNeedingReminder = db.prepare(
  `SELECT * FROM rehearsals
   WHERE status = 'scheduled'
     AND reminder_sent = 0
     AND (scheduled_at - ?) <= ?
     AND ? < scheduled_at
   ORDER BY scheduled_at ASC`,
);
const updateRehearsalReminderSent = db.prepare(
  `UPDATE rehearsals SET reminder_sent = 1, updated_at = ? WHERE id = ?`,
);
const upsertAvailability = db.prepare(
  `INSERT INTO availability (rehearsal_id, member_id, member_name, response, responded_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(rehearsal_id, member_id) DO UPDATE SET
     response = excluded.response,
     member_name = excluded.member_name,
     responded_at = excluded.responded_at`,
);
const selectAvailabilityByRehearsalAndMember = db.prepare(
  `SELECT * FROM availability WHERE rehearsal_id = ? AND member_id = ?`,
);
const selectAvailabilityByRehearsal = db.prepare(
  `SELECT * FROM availability WHERE rehearsal_id = ? ORDER BY response ASC, responded_at ASC`,
);
const insertSetlist = db.prepare(
  `INSERT INTO setlists (name, notes, created_at, updated_at) VALUES (?, ?, ?, ?)`,
);
const selectSetlistById = db.prepare(`SELECT * FROM setlists WHERE id = ?`);
const selectSetlistByNameLower = db.prepare(`SELECT * FROM setlists WHERE lower(name) = lower(?)`);
const selectAllSetlists = db.prepare(`SELECT * FROM setlists ORDER BY name ASC`);
const deleteSetlistById = db.prepare(`DELETE FROM setlists WHERE id = ?`);
const insertSetlistSong = db.prepare(
  `INSERT INTO setlist_songs (setlist_id, song_id, position) VALUES (?, ?, ?)`,
);
const selectSetlistSongById = db.prepare(`SELECT * FROM setlist_songs WHERE id = ?`);
const selectMaxSetlistSongPosition = db.prepare(
  `SELECT MAX(position) AS maxPosition FROM setlist_songs WHERE setlist_id = ?`,
);
const selectSetlistSongBySetlistAndSong = db.prepare(
  `SELECT * FROM setlist_songs WHERE setlist_id = ? AND song_id = ?`,
);
const selectSetlistSongsOrdered = db.prepare(
  `SELECT * FROM setlist_songs WHERE setlist_id = ? ORDER BY position ASC`,
);
const deleteSetlistSongsBySetlist = db.prepare(`DELETE FROM setlist_songs WHERE setlist_id = ?`);
const deleteSetlistSongsBySong = db.prepare(`DELETE FROM setlist_songs WHERE song_id = ?`);
const deleteSetlistSongRow = db.prepare(
  `DELETE FROM setlist_songs WHERE setlist_id = ? AND song_id = ?`,
);
const updateSetlistSongPosition = db.prepare(`UPDATE setlist_songs SET position = ? WHERE id = ?`);
const selectSetlistEntriesJoined = db.prepare(
  `SELECT setlist_songs.position AS position, songs.*
   FROM setlist_songs
   JOIN songs ON songs.id = setlist_songs.song_id
   WHERE setlist_songs.setlist_id = ?
   ORDER BY setlist_songs.position ASC`,
);
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

const BRIDGE_OUTBOX_STALE_CLAIM_MS = 120_000;

function bridgeOutboxSupportsClaimed(): boolean {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bridge_outbox'",
  ).get() as { sql: string | null } | undefined;
  return row?.sql?.includes("'claimed'") ?? false;
}

if (!bridgeOutboxSupportsClaimed()) {
  db.exec(`
    CREATE TABLE bridge_outbox_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      envelope_json TEXT NOT NULL,
      target_instance TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','claimed','sent','dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );

    INSERT INTO bridge_outbox_new
      (id, envelope_json, target_instance, status, attempts, next_attempt_at, last_error, created_at)
    SELECT id, envelope_json, target_instance, status, attempts, next_attempt_at, last_error, created_at
    FROM bridge_outbox;

    DROP TABLE bridge_outbox;
    ALTER TABLE bridge_outbox_new RENAME TO bridge_outbox;

    CREATE INDEX IF NOT EXISTS idx_bridge_outbox_status_next_attempt
      ON bridge_outbox (status, next_attempt_at);
  `);
}

const insertBridgeOutbox = db.prepare(
  `INSERT INTO bridge_outbox
   (envelope_json, target_instance, status, attempts, next_attempt_at, created_at)
   VALUES (?, ?, 'pending', 0, ?, ?)`,
);
const selectBridgeOutboxById = db.prepare(`SELECT * FROM bridge_outbox WHERE id = ?`);
const claimDueBridgeOutboxRows = db.prepare(
  `UPDATE bridge_outbox
   SET status = 'claimed', next_attempt_at = @now
   WHERE id IN (
     SELECT id FROM bridge_outbox
     WHERE (status = 'pending' AND next_attempt_at <= @now)
        OR (status = 'claimed' AND next_attempt_at <= @staleBefore)
     ORDER BY id ASC
     LIMIT @limit
   )
   RETURNING *`,
);
const updateBridgeOutboxSent = db.prepare(
  `UPDATE bridge_outbox
   SET status = 'sent', last_error = NULL
   WHERE id = ? AND status = 'claimed'`,
);
const updateBridgeOutboxDead = db.prepare(
  `UPDATE bridge_outbox
   SET status = 'dead', attempts = attempts + 1, last_error = ?
   WHERE id = ? AND status IN ('pending', 'claimed')`,
);
const updateBridgeOutboxAttempt = db.prepare(
  `UPDATE bridge_outbox
   SET status = 'pending', attempts = attempts + 1, next_attempt_at = ?, last_error = ?
   WHERE id = ? AND status IN ('pending', 'claimed')`,
);
const insertBridgeSeen = db.prepare(
  `INSERT OR IGNORE INTO bridge_seen (idempotency_key, seen_at) VALUES (?, ?)`,
);
const deleteBridgeSeen = db.prepare(
  `DELETE FROM bridge_seen WHERE idempotency_key = ?`,
);
const insertBridgeBuffer = db.prepare(
  `INSERT INTO bridge_buffer (route_id, envelope_json, buffered_at) VALUES (?, ?, ?)`,
);
const selectBridgeBufferByRoute = db.prepare(
  // buffered_at first: restored rows get NEW autoincrement ids, so id order
  // would sort them after messages that arrived mid-flush, inverting the
  // oldest-dropped truncation guarantee. buffered_at survives restore.
  `SELECT * FROM bridge_buffer WHERE route_id = ? ORDER BY buffered_at ASC, id ASC`,
);
const deleteBridgeBufferByRoute = db.prepare(`DELETE FROM bridge_buffer WHERE route_id = ?`);
const selectBridgeBufferDepths = db.prepare(
  `SELECT route_id, COUNT(*) as count FROM bridge_buffer GROUP BY route_id`,
);
const selectBridgeOutboxCounts = db.prepare(
  `SELECT
     SUM(CASE WHEN status IN ('pending', 'claimed') THEN 1 ELSE 0 END) AS pending,
     SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
     SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead,
     MIN(CASE WHEN status IN ('pending', 'claimed') THEN created_at ELSE NULL END) AS oldestPendingCreatedAt
   FROM bridge_outbox`,
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
    extra: {
      topics: summary.topicTags,
      timeRange: [session.started_at, session.ended_at],
      messageCount: session.message_count,
      participants,
    },
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

/** Distinct chat JIDs that have stored messages — for vector backfill enumeration. */
export function listMessageChatJids(): string[] {
  const rows = selectDistinctMessageChats.all() as Array<{ chat_jid: string }>;
  return rows.map((row) => row.chat_jid);
}

/** All summarized sessions across every chat — for vector backfill enumeration. */
export function listSummarizedSessions(limit: number = Number.MAX_SAFE_INTEGER): BackfillSession[] {
  const rows = selectAllSummarizedSessions.all(limit) as Array<SessionSummaryRow & { chat_jid: string }>;
  return rows.map((row) => ({
    sessionId: toNumber(row.id),
    chatJid: row.chat_jid,
    startedAt: toNumber(row.started_at),
    endedAt: toNumber(row.ended_at),
    messageCount: toNumber(row.message_count),
    participants: parseJsonArray(row.participants),
    topicTags: parseJsonArray(row.topic_tags),
    summaryText: row.summary_text,
  }));
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

// ── Public API: Bridge Outbox ──────────────────────────────────────

export function enqueueBridgeOutbox(envelope: BridgeEnvelope): BridgeOutboxEntry {
  const now = Date.now();
  const result = insertBridgeOutbox.run(
    JSON.stringify(envelope),
    envelope.targetInstance,
    now,
    now,
  );
  return mapBridgeOutboxEntry(selectBridgeOutboxById.get(result.lastInsertRowid) as BridgeOutboxRow);
}

export function claimDueBridgeOutbox(limit: number): BridgeOutboxEntry[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  const now = Date.now();
  return (claimDueBridgeOutboxRows.all({
    now,
    staleBefore: now - BRIDGE_OUTBOX_STALE_CLAIM_MS,
    limit: safeLimit,
  }) as BridgeOutboxRow[]).map(mapBridgeOutboxEntry);
}

export function markBridgeOutboxSent(id: number): boolean {
  return updateBridgeOutboxSent.run(id).changes > 0;
}

export function markBridgeOutboxDead(id: number, error: string): boolean {
  return updateBridgeOutboxDead.run(error, id).changes > 0;
}

export function bumpBridgeOutboxAttempt(id: number, nextAt: number, error: string): boolean {
  return updateBridgeOutboxAttempt.run(nextAt, error, id).changes > 0;
}

export function bridgeSeenInsert(key: string): boolean {
  return insertBridgeSeen.run(key, Date.now()).changes > 0;
}

/**
 * Remove a dedup key inserted by `bridgeSeenInsert`. Used when a delivery
 * attempt throws AFTER the key was inserted (T6-review required fix): without
 * this, a thrown delivery error would leave the key seen, so the sender's
 * retry of the SAME message would be silently dropped as a duplicate instead
 * of being retried fresh.
 */
export function bridgeSeenDelete(key: string): boolean {
  return deleteBridgeSeen.run(key).changes > 0;
}

export function bridgeOutboxCounts(): BridgeOutboxCounts {
  const row = selectBridgeOutboxCounts.get() as {
    pending: number | null;
    sent: number | null;
    dead: number | null;
    oldestPendingCreatedAt: number | null;
  };
  return {
    pending: toNumber(row.pending ?? 0),
    sent: toNumber(row.sent ?? 0),
    dead: toNumber(row.dead ?? 0),
    oldestPendingCreatedAt: row.oldestPendingCreatedAt === null ? null : toNumber(row.oldestPendingCreatedAt),
  };
}

// ── Public API: Bridge Summary Buffer (Task 7) ─────────────────────

/**
 * Atomically read and clear all buffered rows for a route (oldest first).
 * better-sqlite3 executes synchronously, so the select+delete pair below
 * cannot interleave with a concurrent append on the same process — no
 * explicit BEGIN/COMMIT is needed for that guarantee, but we still wrap it
 * in a transaction for clarity and to keep the pattern consistent with the
 * other multi-statement writes in this file.
 */
const takeBridgeBufferTxn = db.transaction((routeId: string): BridgeBufferRow[] => {
  const rows = selectBridgeBufferByRoute.all(routeId) as BridgeBufferRow[];
  if (rows.length > 0) deleteBridgeBufferByRoute.run(routeId);
  return rows;
});

const restoreBridgeBufferTxn = db.transaction((rows: BridgeBufferEntry[]): void => {
  for (const row of rows) {
    insertBridgeBuffer.run(row.routeId, row.envelopeJson, row.bufferedAt);
  }
});

/** Append one envelope to a route's buffer. Never sends — the flusher does that. */
export function appendBridgeBuffer(routeId: string, envelopeJson: string): void {
  insertBridgeBuffer.run(routeId, envelopeJson, Date.now());
}

/** Atomically take (read + delete) all buffered rows for a route, oldest first. */
export function takeBridgeBuffer(routeId: string): BridgeBufferEntry[] {
  return takeBridgeBufferTxn(routeId).map(mapBridgeBufferEntry);
}

/** Re-insert previously taken rows, preserving their original order and timestamps. */
export function restoreBridgeBuffer(rows: BridgeBufferEntry[]): void {
  if (rows.length === 0) return;
  restoreBridgeBufferTxn(rows);
}

/** Current buffer depth (row count) per route id, for routes with at least one buffered row. */
export function bridgeBufferDepths(): Record<string, number> {
  const rows = selectBridgeBufferDepths.all() as Array<{ route_id: string; count: number }>;
  const depths: Record<string, number> = {};
  for (const row of rows) depths[row.route_id] = toNumber(row.count);
  return depths;
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
export function addMemory(fact: string, category: string = 'general', source: string = 'owner'): LocalMemoryEntry {
  const ts = Math.floor(Date.now() / 1000);
  const result = insertMemory.run(fact, category, source, ts);
  return { id: Number(result.lastInsertRowid), fact, category, source, created_at: ts };
}

/** Get all stored memories */
export function getAllMemories(): LocalMemoryEntry[] {
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

// ── Public API: Songs (shared band memory) ──────────────────────────

export interface NewSong {
  title: string;
  key?: string | null;
  tempo?: number | null;
  status?: SongStatus;
  notes?: string | null;
}

/** Add a new song to the shared band memory. Defaults status to 'idea'. */
export function addSong(input: NewSong): Song {
  const ts = Math.floor(Date.now() / 1000);
  const result = insertSong.run(
    input.title,
    input.key ?? null,
    input.tempo ?? null,
    input.status ?? 'idea',
    input.notes ?? null,
    ts,
    ts,
  );
  return mapSong(selectSongById.get(result.lastInsertRowid) as SongRow);
}

/** Get a song by ID. */
export function getSongById(id: number): Song | undefined {
  const row = selectSongById.get(id) as SongRow | undefined;
  return row ? mapSong(row) : undefined;
}

/** Get a song by title (case-insensitive). */
export function getSongByTitle(title: string): Song | undefined {
  const row = selectSongByTitleLower.get(title) as SongRow | undefined;
  return row ? mapSong(row) : undefined;
}

/** List all songs, optionally filtered by status. */
export function listSongs(status?: SongStatus): Song[] {
  const rows = status
    ? (selectSongsByStatus.all(status) as SongRow[])
    : (selectAllSongs.all() as SongRow[]);
  return rows.map(mapSong);
}

/** Update only the provided fields on a song and bump updated_at. */
export function updateSong(
  id: number,
  patch: Partial<{ title: string; key: string | null; tempo: number | null; status: SongStatus; notes: string | null }>,
): Song | undefined {
  const existing = selectSongById.get(id) as SongRow | undefined;
  if (!existing) return undefined;

  const ts = Math.floor(Date.now() / 1000);
  updateSongRow.run(
    patch.title ?? existing.title,
    patch.key !== undefined ? patch.key : existing.song_key,
    patch.tempo !== undefined ? patch.tempo : existing.tempo,
    patch.status ?? existing.status,
    patch.notes !== undefined ? patch.notes : existing.notes,
    ts,
    id,
  );
  return mapSong(selectSongById.get(id) as SongRow);
}

/**
 * Delete a song by ID. Also removes any setlist_songs and song_sections
 * entries referencing it, and nulls out song_id on any linked song_ideas
 * (sqlite does not run with `PRAGMA foreign_keys=ON`, so ON DELETE
 * CASCADE/SET NULL on those tables' song_id columns is inert here — this
 * cleanup makes the DB layer correct without relying on that pragma).
 */
export function deleteSong(id: number): boolean {
  deleteSetlistSongsBySong.run(id);
  deleteSongSectionsBySong.run(id);
  nullSongIdeasBySongId.run(id);
  return deleteSongById.run(id).changes > 0;
}

// ── Public API: Song Ideas (shared band songwriting scratchpad) ─────

export interface NewSongIdea {
  title?: string | null;
  text?: string | null;
  audioUrl?: string | null;
  transcript?: string | null;
  songId?: number | null;
  createdBy?: string | null;
}

/** Add a new song idea (a scratchpad entry, optionally linked to a song). */
export function addSongIdea(input: NewSongIdea): SongIdea {
  const ts = Math.floor(Date.now() / 1000);
  const result = insertSongIdea.run(
    input.title ?? null,
    input.text ?? null,
    input.audioUrl ?? null,
    input.transcript ?? null,
    input.songId ?? null,
    input.createdBy ?? null,
    ts,
  );
  return mapSongIdea(selectSongIdeaById.get(result.lastInsertRowid) as SongIdeaRow);
}

/** Get a song idea by ID. */
export function getSongIdeaById(id: number): SongIdea | undefined {
  const row = selectSongIdeaById.get(id) as SongIdeaRow | undefined;
  return row ? mapSongIdea(row) : undefined;
}

/** List song ideas, newest first, optionally limited. */
export function listSongIdeas(limit?: number): SongIdea[] {
  const rows = limit !== undefined
    ? (selectSongIdeasNewestFirstLimited.all(limit) as SongIdeaRow[])
    : (selectSongIdeasNewestFirst.all() as SongIdeaRow[]);
  return rows.map(mapSongIdea);
}

/** Link a song idea to a song, setting its song_id. */
export function linkSongIdeaToSong(ideaId: number, songId: number): boolean {
  return updateSongIdeaSongId.run(songId, ideaId).changes > 0;
}

/** Delete a song idea by ID. */
export function deleteSongIdea(id: number): boolean {
  return deleteSongIdeaById.run(id).changes > 0;
}

// ── Public API: Rehearsals (shared band practice memory) ───────────

export interface NewRehearsal {
  scheduledAt: number;
  location?: string | null;
  agenda?: string | null;
  createdBy?: string | null;
}

/** Add a new rehearsal. Defaults status to 'scheduled' and reminder_sent to false. */
export function addRehearsal(input: NewRehearsal): Rehearsal {
  const ts = Math.floor(Date.now() / 1000);
  const result = insertRehearsal.run(
    input.scheduledAt,
    input.location ?? null,
    input.agenda ?? null,
    input.createdBy ?? null,
    ts,
    ts,
  );
  return mapRehearsal(selectRehearsalById.get(result.lastInsertRowid) as RehearsalRow);
}

/** Get a rehearsal by ID. */
export function getRehearsalById(id: number): Rehearsal | undefined {
  const row = selectRehearsalById.get(id) as RehearsalRow | undefined;
  return row ? mapRehearsal(row) : undefined;
}

/** List scheduled rehearsals at or after now, ordered by start time. */
export function listUpcomingRehearsals(nowSeconds: number, limit: number = 20): Rehearsal[] {
  return (selectUpcomingRehearsals.all(nowSeconds, limit) as RehearsalRow[]).map(mapRehearsal);
}

/** Get the next scheduled rehearsal at or after now. */
export function getNextRehearsal(nowSeconds: number): Rehearsal | undefined {
  const row = selectNextRehearsal.get(nowSeconds) as RehearsalRow | undefined;
  return row ? mapRehearsal(row) : undefined;
}

/** Update only the provided fields on a rehearsal and bump updated_at. */
export function updateRehearsal(
  id: number,
  patch: Partial<{ scheduledAt: number; location: string | null; agenda: string | null; status: RehearsalStatus }>,
): Rehearsal | undefined {
  const existing = selectRehearsalById.get(id) as RehearsalRow | undefined;
  if (!existing) return undefined;

  const ts = Math.floor(Date.now() / 1000);
  updateRehearsalRow.run(
    patch.scheduledAt ?? existing.scheduled_at,
    patch.location !== undefined ? patch.location : existing.location,
    patch.agenda !== undefined ? patch.agenda : existing.agenda,
    patch.status ?? existing.status,
    ts,
    id,
  );
  return mapRehearsal(selectRehearsalById.get(id) as RehearsalRow);
}

/** Cancel a rehearsal by ID. */
export function cancelRehearsal(id: number): boolean {
  const ts = Math.floor(Date.now() / 1000);
  return updateRehearsalCancelled.run(ts, id).changes > 0;
}

/** List scheduled rehearsals whose reminder window has opened. */
export function listRehearsalsNeedingReminder(nowSeconds: number): Rehearsal[] {
  const leadSeconds = config.REHEARSAL_REMINDER_LEAD_MINUTES * 60;
  return (selectRehearsalsNeedingReminder.all(leadSeconds, nowSeconds, nowSeconds) as RehearsalRow[])
    .map(mapRehearsal);
}

/** Mark the rehearsal reminder as sent. */
export function markRehearsalReminderSent(id: number): boolean {
  const ts = Math.floor(Date.now() / 1000);
  return updateRehearsalReminderSent.run(ts, id).changes > 0;
}

// ── Public API: Availability (per-rehearsal band member RSVPs) ─────

/** Set (or update) a member's availability response for a rehearsal. Upserts on (rehearsal, member). */
export function setAvailability(
  rehearsalId: number,
  memberId: string,
  memberName: string | null,
  response: AvailabilityResponse,
): Availability {
  const ts = Math.floor(Date.now() / 1000);
  upsertAvailability.run(rehearsalId, memberId, memberName, response, ts);
  return mapAvailability(
    selectAvailabilityByRehearsalAndMember.get(rehearsalId, memberId) as AvailabilityRow,
  );
}

/** List all availability responses for a rehearsal, grouped by response then response time. */
export function listAvailability(rehearsalId: number): Availability[] {
  return (selectAvailabilityByRehearsal.all(rehearsalId) as AvailabilityRow[]).map(mapAvailability);
}

// ── Public API: Setlists (ordered song lists referencing shared songs) ─────

export interface NewSetlist {
  name: string;
  notes?: string | null;
}

/** Add a new setlist. */
export function addSetlist(input: NewSetlist): Setlist {
  const ts = Math.floor(Date.now() / 1000);
  const result = insertSetlist.run(input.name, input.notes ?? null, ts, ts);
  return mapSetlist(selectSetlistById.get(result.lastInsertRowid) as SetlistRow);
}

/** Get a setlist by name (case-insensitive). */
export function getSetlistByName(name: string): Setlist | undefined {
  const row = selectSetlistByNameLower.get(name) as SetlistRow | undefined;
  return row ? mapSetlist(row) : undefined;
}

/** List all setlists, alphabetically by name. */
export function listSetlists(): Setlist[] {
  return (selectAllSetlists.all() as SetlistRow[]).map(mapSetlist);
}

/** Delete a setlist and its setlist_songs entries. */
export function deleteSetlist(id: number): boolean {
  deleteSetlistSongsBySetlist.run(id);
  return deleteSetlistById.run(id).changes > 0;
}

/**
 * Reassign positions 1..N (in the given order) for a setlist's songs.
 * Uses a negative-position intermediate pass first: setlist_songs has a
 * UNIQUE(setlist_id, position) constraint, so writing final positions
 * directly can collide with a row's current position mid-sequence.
 */
const reassignSetlistSongPositions = db.transaction((rows: SetlistSongRow[]): void => {
  rows.forEach((row, index) => {
    updateSetlistSongPosition.run(-(index + 1), row.id);
  });
  rows.forEach((row, index) => {
    updateSetlistSongPosition.run(index + 1, row.id);
  });
});

/** Add a song to a setlist. Appends to the end (max position + 1) when no position is given. */
export function addSongToSetlist(setlistId: number, songId: number, position?: number): SetlistSong {
  let pos = position;
  if (pos === undefined) {
    const row = selectMaxSetlistSongPosition.get(setlistId) as { maxPosition: number | null };
    pos = (row.maxPosition ?? 0) + 1;
  }
  const result = insertSetlistSong.run(setlistId, songId, pos);
  return mapSetlistSong(selectSetlistSongById.get(result.lastInsertRowid) as SetlistSongRow);
}

/** Remove a song from a setlist, then re-close position gaps so 1..N stays contiguous. */
export function removeSongFromSetlist(setlistId: number, songId: number): boolean {
  const removed = deleteSetlistSongRow.run(setlistId, songId).changes > 0;
  if (removed) {
    const rows = selectSetlistSongsOrdered.all(setlistId) as SetlistSongRow[];
    reassignSetlistSongPositions(rows);
  }
  return removed;
}

/** Move a song within a setlist to a new 1-based position, reordering the rest. */
export function moveSetlistSong(setlistId: number, songId: number, newPosition: number): boolean {
  const target = selectSetlistSongBySetlistAndSong.get(setlistId, songId) as SetlistSongRow | undefined;
  if (!target) return false;

  const rows = selectSetlistSongsOrdered.all(setlistId) as SetlistSongRow[];
  const clampedPosition = Math.max(1, Math.min(newPosition, rows.length));
  const reordered = rows.filter((row) => row.id !== target.id);
  reordered.splice(clampedPosition - 1, 0, target);

  reassignSetlistSongPositions(reordered);
  return true;
}

/** Get a setlist's songs, JOINed with their song data, ordered by position. */
export function getSetlistSongs(setlistId: number): SetlistEntry[] {
  return (selectSetlistEntriesJoined.all(setlistId) as SetlistEntryRow[]).map(mapSetlistEntry);
}

// ── Public API: Song Sections (per-song structure: intro/verse/chorus/...) ──

export interface NewSongSection {
  songId: number;
  kind: SectionKind;
  lyrics?: string | null;
  chords?: string | null;
  position?: number;
}

/**
 * Reassign positions 1..N (in the given order) for a song's sections.
 * Uses a negative-position intermediate pass first: song_sections has a
 * UNIQUE(song_id, position) constraint, so writing final positions directly
 * can collide with a row's current position mid-sequence.
 */
const reassignSongSectionPositions = db.transaction((rows: SongSectionRow[]): void => {
  rows.forEach((row, index) => {
    updateSongSectionPosition.run(-(index + 1), row.id);
  });
  rows.forEach((row, index) => {
    updateSongSectionPosition.run(index + 1, row.id);
  });
});

/** Add a section to a song. Appends to the end (max position + 1) when no position is given. */
export function addSongSection(input: NewSongSection): SongSection {
  let pos = input.position;
  if (pos === undefined) {
    const row = selectMaxSongSectionPosition.get(input.songId) as { maxPosition: number | null };
    pos = (row.maxPosition ?? 0) + 1;
  }
  const ts = Math.floor(Date.now() / 1000);
  const result = insertSongSection.run(
    input.songId,
    input.kind,
    pos,
    input.lyrics ?? null,
    input.chords ?? null,
    ts,
    ts,
  );
  return mapSongSection(selectSongSectionById.get(result.lastInsertRowid) as SongSectionRow);
}

/** Get a song's sections, ordered by position. */
export function getSongSections(songId: number): SongSection[] {
  return (selectSongSectionsOrdered.all(songId) as SongSectionRow[]).map(mapSongSection);
}

/** Update only the provided fields on a section and bump updated_at. */
export function updateSongSection(
  id: number,
  patch: Partial<{ kind: SectionKind; lyrics: string | null; chords: string | null }>,
): SongSection | undefined {
  const existing = selectSongSectionById.get(id) as SongSectionRow | undefined;
  if (!existing) return undefined;

  const ts = Math.floor(Date.now() / 1000);
  updateSongSectionRow.run(
    patch.kind ?? existing.kind,
    patch.lyrics !== undefined ? patch.lyrics : existing.lyrics,
    patch.chords !== undefined ? patch.chords : existing.chords,
    ts,
    id,
  );
  return mapSongSection(selectSongSectionById.get(id) as SongSectionRow);
}

/** Move a section within its song to a new 1-based position, reordering the rest. */
export function moveSongSection(id: number, newPosition: number): boolean {
  const target = selectSongSectionById.get(id) as SongSectionRow | undefined;
  if (!target) return false;

  const rows = selectSongSectionsOrdered.all(target.song_id) as SongSectionRow[];
  const clampedPosition = Math.max(1, Math.min(newPosition, rows.length));
  const reordered = rows.filter((row) => row.id !== target.id);
  reordered.splice(clampedPosition - 1, 0, target);

  reassignSongSectionPositions(reordered);
  return true;
}

/** Remove a section, then re-close position gaps so 1..N stays contiguous for that song. */
export function removeSongSection(id: number): boolean {
  const target = selectSongSectionById.get(id) as SongSectionRow | undefined;
  if (!target) return false;

  const removed = deleteSongSectionById.run(id).changes > 0;
  if (removed) {
    const rows = selectSongSectionsOrdered.all(target.song_id) as SongSectionRow[];
    reassignSongSectionPositions(rows);
  }
  return removed;
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
    listMessageChatJids: async () => listMessageChatJids(),
    listSummarizedSessions: async (limit?: number) => listSummarizedSessions(limit),

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

    enqueueBridgeOutbox: async (envelope: BridgeEnvelope) => enqueueBridgeOutbox(envelope),
    claimDueBridgeOutbox: async (limit: number) => claimDueBridgeOutbox(limit),
    markBridgeOutboxSent: async (id: number) => markBridgeOutboxSent(id),
    markBridgeOutboxDead: async (id: number, error: string) => markBridgeOutboxDead(id, error),
    bumpBridgeOutboxAttempt: async (id: number, nextAt: number, error: string) =>
      bumpBridgeOutboxAttempt(id, nextAt, error),
    bridgeSeenInsert: async (key: string) => bridgeSeenInsert(key),
    bridgeSeenDelete: async (key: string) => bridgeSeenDelete(key),
    bridgeOutboxCounts: async () => bridgeOutboxCounts(),

    appendBridgeBuffer: async (routeId: string, envelopeJson: string): Promise<void> => {
      appendBridgeBuffer(routeId, envelopeJson);
    },
    takeBridgeBuffer: async (routeId: string) => takeBridgeBuffer(routeId),
    restoreBridgeBuffer: async (rows: BridgeBufferEntry[]): Promise<void> => {
      restoreBridgeBuffer(rows);
    },
    bridgeBufferDepths: async () => bridgeBufferDepths(),

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

    addSong: async (input: NewSong) => addSong(input),
    getSongById: async (id: number) => getSongById(id),
    getSongByTitle: async (title: string) => getSongByTitle(title),
    listSongs: async (status?: SongStatus) => listSongs(status),
    updateSong: async (
      id: number,
      patch: Partial<{ title: string; key: string | null; tempo: number | null; status: SongStatus; notes: string | null }>,
    ) => updateSong(id, patch),
    deleteSong: async (id: number) => deleteSong(id),

    addSongIdea: async (input: NewSongIdea) => addSongIdea(input),
    getSongIdeaById: async (id: number) => getSongIdeaById(id),
    listSongIdeas: async (limit?: number) => listSongIdeas(limit),
    linkSongIdeaToSong: async (ideaId: number, songId: number) => linkSongIdeaToSong(ideaId, songId),
    deleteSongIdea: async (id: number) => deleteSongIdea(id),

    addRehearsal: async (input: NewRehearsal) => addRehearsal(input),
    getRehearsalById: async (id: number) => getRehearsalById(id),
    listUpcomingRehearsals: async (nowSeconds: number, limit?: number) =>
      listUpcomingRehearsals(nowSeconds, limit),
    getNextRehearsal: async (nowSeconds: number) => getNextRehearsal(nowSeconds),
    updateRehearsal: async (
      id: number,
      patch: Partial<{ scheduledAt: number; location: string | null; agenda: string | null; status: RehearsalStatus }>,
    ) => updateRehearsal(id, patch),
    cancelRehearsal: async (id: number) => cancelRehearsal(id),
    listRehearsalsNeedingReminder: async (nowSeconds: number) =>
      listRehearsalsNeedingReminder(nowSeconds),
    markRehearsalReminderSent: async (id: number) => markRehearsalReminderSent(id),

    setAvailability: async (
      rehearsalId: number,
      memberId: string,
      memberName: string | null,
      response: AvailabilityResponse,
    ) => setAvailability(rehearsalId, memberId, memberName, response),
    listAvailability: async (rehearsalId: number) => listAvailability(rehearsalId),

    addSetlist: async (input: NewSetlist) => addSetlist(input),
    getSetlistByName: async (name: string) => getSetlistByName(name),
    listSetlists: async () => listSetlists(),
    deleteSetlist: async (id: number) => deleteSetlist(id),
    addSongToSetlist: async (setlistId: number, songId: number, position?: number) =>
      addSongToSetlist(setlistId, songId, position),
    removeSongFromSetlist: async (setlistId: number, songId: number) =>
      removeSongFromSetlist(setlistId, songId),
    moveSetlistSong: async (setlistId: number, songId: number, newPosition: number) =>
      moveSetlistSong(setlistId, songId, newPosition),
    getSetlistSongs: async (setlistId: number) => getSetlistSongs(setlistId),

    addSongSection: async (input: NewSongSection) => addSongSection(input),
    getSongSections: async (songId: number) => getSongSections(songId),
    updateSongSection: async (
      id: number,
      patch: Partial<{ kind: SectionKind; lyrics: string | null; chords: string | null }>,
    ) => updateSongSection(id, patch),
    moveSongSection: async (id: number, newPosition: number) => moveSongSection(id, newPosition),
    removeSongSection: async (id: number) => removeSongSection(id),

    closeDb: async (): Promise<void> => {
      closeDb();
    },
  };
}
