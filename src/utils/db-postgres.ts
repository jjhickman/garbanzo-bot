import { existsSync, readFileSync } from 'fs';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

import { logger } from '../middleware/logger.js';
import { recordSessionSummaryLifecycle } from '../middleware/stats.js';
import type { BridgeEnvelope } from '../bridge/envelope.js';
import { config } from './config.js';
import { assetPath } from './paths.js';
import { summarizeSession, scoreSessionMatch, buildContextualizedEmbeddingInput } from './session-summary.js';
import { indexSession } from './vector-memory.js';
import type { DbBackend } from './db-backend.js';
import {
  mapAvailability,
  mapDailyGroupActivity,
  mapDbMessage,
  mapEventReminder,
  mapFeedbackEntry,
  mapMemoryEntry,
  mapMemberProfile,
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
  type DailyGroupActivityRow,
  type EventReminderRow,
  type FeedbackRow,
  type MemoryRow,
  type MessageRow,
  type ProfileRow,
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
  extractSearchTerms,
  formatMemoriesForPromptEntries,
  mapWhatsAppSafetyMetrics,
  parseJsonArray,
  toBareJid,
  toNumber,
  type DbNumeric,
  type WhatsAppMetricCountsLike,
} from './db-query-shape.js';
import type {
  AdminAuditLogEntry,
  AdminAuditLogInput,
  Availability,
  AvailabilityResponse,
  BackupIntegrityStatus,
  BridgeBufferEntry,
  BridgeOutboxCounts,
  BridgeOutboxEntry,
  DailyGroupActivity,
  DbMessage,
  EventReminder,
  BackfillSession,
  FeedbackEntry,
  MaintenanceStats,
  MemberProfile,
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

const MAX_MESSAGES_PER_CHAT = 5000;
const MESSAGE_RETENTION_DAYS = 30;
const CONTEXT_RELEVANT_LIMIT = 6;
const SESSION_FETCH_LIMIT = 160;
const ADMIN_AUDIT_RETENTION_DAYS = 90;

const REQUIRED_CORE_TABLES = [
  'member_profiles',
  'messages',
  'conversation_sessions',
  'moderation_log',
  'daily_stats',
  'feedback',
  'event_reminders',
  'memory',
  'admin_audit_log',
  'whatsapp_outbound_jobs',
  'whatsapp_safety_state',
  'songs',
  'song_ideas',
  'song_sections',
  'rehearsals',
  'availability',
  'setlists',
  'setlist_songs',
] as const;

interface DbCountRow {
  count: DbNumeric;
}

interface OpenSessionRow {
  id: DbNumeric;
  started_at: DbNumeric;
  ended_at: DbNumeric;
  message_count: DbNumeric;
  participants: unknown;
}

type SessionIndexPayload = Parameters<typeof indexSession>[0];

function createMaintenanceScheduler(
  backupDatabase: () => Promise<string>,
  runMaintenance: () => Promise<MaintenanceStats>,
): { scheduleMaintenance: () => void; stopMaintenance: () => void } {
  let maintenanceTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleMaintenance = (): void => {
    const now = new Date();
    const next4AM = new Date(now);
    next4AM.setHours(4, 0, 0, 0);

    if (now >= next4AM) {
      next4AM.setDate(next4AM.getDate() + 1);
    }

    const msUntil = next4AM.getTime() - now.getTime();

    maintenanceTimer = setTimeout(() => {
      void (async () => {
        try {
          await backupDatabase();
        } catch (err) {
          logger.error({ err }, 'Postgres backup advisory step failed');
        }

        try {
          await runMaintenance();
        } catch (err) {
          logger.error({ err }, 'Postgres maintenance failed');
        }

        scheduleMaintenance();
      })();
    }, msUntil);

    logger.info({
      nextRun: next4AM.toISOString(),
      inHours: +(msUntil / 3_600_000).toFixed(1),
      dialect: 'postgres',
    }, 'Database maintenance scheduled');
  };

  const stopMaintenance = (): void => {
    if (maintenanceTimer) {
      clearTimeout(maintenanceTimer);
      maintenanceTimer = null;
    }
  };

  return { scheduleMaintenance, stopMaintenance };
}

function resolvePostgresConnectionString(): string {
  if (config.DATABASE_URL) return config.DATABASE_URL;

  if (!config.POSTGRES_HOST || !config.POSTGRES_DB || !config.POSTGRES_USER || !config.POSTGRES_PASSWORD) {
    throw new Error('Missing postgres connection settings. Set DATABASE_URL or POSTGRES_HOST/POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD.');
  }

  const encodedUser = encodeURIComponent(config.POSTGRES_USER);
  const encodedPass = encodeURIComponent(config.POSTGRES_PASSWORD);
  return `postgres://${encodedUser}:${encodedPass}@${config.POSTGRES_HOST}:${config.POSTGRES_PORT}/${config.POSTGRES_DB}`;
}

function resolveSchemaPath(): string | undefined {
  const candidates = [
    assetPath('src', 'utils', 'postgres-schema.sql'),
    assetPath('dist', 'utils', 'postgres-schema.sql'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

async function validateCoreTables(pool: Pool): Promise<void> {
  const res = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [Array.from(REQUIRED_CORE_TABLES)],
  );

  const available = new Set(res.rows.map((row) => row.table_name));
  const missing = REQUIRED_CORE_TABLES.filter((table) => !available.has(table));
  if (missing.length > 0) {
    throw new Error(
      `Postgres schema is incomplete; missing tables: ${missing.join(', ')}. `
      + 'Run `npm run db:postgres:init` (or ensure postgres-schema.sql is bundled in runtime image).',
    );
  }
}

export async function createPostgresBackend(): Promise<DbBackend> {
  const poolConfig: PoolConfig = { connectionString: resolvePostgresConnectionString() };
  if (config.POSTGRES_SSL) {
    poolConfig.ssl = {
      rejectUnauthorized: config.POSTGRES_SSL_REJECT_UNAUTHORIZED,
    };
  }

  const pool = new Pool(poolConfig);

  const schemaPath = resolveSchemaPath();
  if (schemaPath) {
    const schemaSql = readFileSync(schemaPath, 'utf-8');
    await pool.query(schemaSql);
  } else {
    logger.warn('postgres-schema.sql not found in runtime filesystem; relying on existing DB tables');
  }

  await validateCoreTables(pool);

  await pool.query('SELECT 1');
  logger.info({ postgresSsl: config.POSTGRES_SSL }, 'Postgres backend initialized');

  const finalizeSessionSummary = async (
    client: PoolClient,
    chatJid: string,
    session: OpenSessionRow,
  ): Promise<SessionIndexPayload | null> => {
    const sessionId = toNumber(session.id);
    const startedAt = toNumber(session.started_at);
    const endedAt = toNumber(session.ended_at);
    const messageCount = toNumber(session.message_count);
    const summaryCreatedAt = Math.floor(Date.now() / 1000);

    if (messageCount < config.CONTEXT_SESSION_MIN_MESSAGES) {
      await client.query(
        `UPDATE conversation_sessions
         SET status = 'closed', summary_text = NULL, topic_tags = '[]'::jsonb,
             summary_version = $1, summary_created_at = $2
         WHERE id = $3`,
        [config.CONTEXT_SESSION_SUMMARY_VERSION, summaryCreatedAt, sessionId],
      );
      recordSessionSummaryLifecycle(chatJid, 'skipped');
      return null;
    }

    const messagesRes = await client.query<MessageRow>(
      `SELECT sender, text, timestamp
       FROM messages
       WHERE chat_jid = $1 AND timestamp >= $2 AND timestamp <= $3
       ORDER BY timestamp ASC, id ASC
       LIMIT $4`,
      [chatJid, startedAt, endedAt, SESSION_FETCH_LIMIT],
    );

    if (messagesRes.rows.length < config.CONTEXT_SESSION_MIN_MESSAGES) {
      await client.query(
        `UPDATE conversation_sessions
         SET status = 'closed', summary_text = NULL, topic_tags = '[]'::jsonb,
             summary_version = $1, summary_created_at = $2
         WHERE id = $3`,
        [config.CONTEXT_SESSION_SUMMARY_VERSION, summaryCreatedAt, sessionId],
      );
      recordSessionSummaryLifecycle(chatJid, 'skipped');
      return null;
    }

    const participants = parseJsonArray(session.participants);
    const summary = summarizeSession(messagesRes.rows.map(mapDbMessage), participants);
    const embeddingInput = buildContextualizedEmbeddingInput(summary.summaryText, {
      chatJid,
      startedAt,
      endedAt,
      participants,
      topicTags: summary.topicTags,
    });

    await client.query(
      `UPDATE conversation_sessions
       SET status = 'summarized', summary_text = $1, topic_tags = $2::jsonb,
           summary_version = $3, summary_created_at = $4
       WHERE id = $5`,
      [
        summary.summaryText,
        JSON.stringify(summary.topicTags),
        config.CONTEXT_SESSION_SUMMARY_VERSION,
        summaryCreatedAt,
        sessionId,
      ],
    );

    recordSessionSummaryLifecycle(chatJid, 'created');
    return {
      chatJid,
      refId: String(sessionId),
      embeddingInput,
      summaryText: summary.summaryText,
      createdAt: endedAt,
      extra: {
        topics: summary.topicTags,
        timeRange: [startedAt, endedAt],
        messageCount,
        participants,
      },
    };
  };

  const upsertConversationSession = async (chatJid: string, sender: string, timestamp: number): Promise<void> => {
    if (!config.CONTEXT_SESSION_MEMORY_ENABLED) return;

    const client = await pool.connect();
    const gapSeconds = config.CONTEXT_SESSION_GAP_MINUTES * 60;

    try {
      await client.query('BEGIN');

      const openRes = await client.query<OpenSessionRow>(
        `SELECT id, started_at, ended_at, message_count, participants
         FROM conversation_sessions
         WHERE chat_jid = $1 AND status = 'open'
         ORDER BY ended_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [chatJid],
      );

      const openSession = openRes.rows[0];
      if (!openSession) {
        await client.query(
          `INSERT INTO conversation_sessions
           (chat_jid, started_at, ended_at, message_count, participants, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'open')`,
          [chatJid, timestamp, timestamp, 1, JSON.stringify([sender])],
        );
        await client.query('COMMIT');
        return;
      }

      const openEndedAt = toNumber(openSession.ended_at);
      const openMessageCount = toNumber(openSession.message_count);
      const participants = parseJsonArray(openSession.participants);

      if (timestamp - openEndedAt <= gapSeconds) {
        if (!participants.includes(sender)) participants.push(sender);
        await client.query(
          `UPDATE conversation_sessions
           SET ended_at = $1, message_count = $2, participants = $3::jsonb
           WHERE id = $4`,
          [timestamp, openMessageCount + 1, JSON.stringify(participants), toNumber(openSession.id)],
        );
        await client.query('COMMIT');
        return;
      }

      const sessionIndexPayload = await finalizeSessionSummary(client, chatJid, openSession);

      await client.query(
        `INSERT INTO conversation_sessions
         (chat_jid, started_at, ended_at, message_count, participants, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'open')`,
        [chatJid, timestamp, timestamp, 1, JSON.stringify([sender])],
      );

      await client.query('COMMIT');
      if (sessionIndexPayload) {
        void indexSession(sessionIndexPayload).catch((err) => logger.warn({ err }, 'session vector index failed'));
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      recordSessionSummaryLifecycle(chatJid, 'failed');
      logger.warn({ err, chatJid }, 'Session summary update failed');
    } finally {
      client.release();
    }
  };

  const backupDatabase = async (): Promise<string> => {
    const marker = `postgres-managed-backup:${new Date().toISOString()}`;
    logger.warn(
      'backupDatabase() is advisory in postgres mode. Use managed snapshots (RDS/pg_dump) outside the app runtime.',
    );
    return marker;
  };

  const runMaintenance = async (): Promise<MaintenanceStats> => {
    const beforeRes = await pool.query<DbCountRow>('SELECT COUNT(*)::bigint as count FROM messages');
    const beforeCount = toNumber(beforeRes.rows[0]?.count);

    const cutoff = Math.floor(Date.now() / 1000) - (MESSAGE_RETENTION_DAYS * 24 * 60 * 60);
    const pruneRes = await pool.query('DELETE FROM messages WHERE timestamp < $1', [cutoff]);
    const pruned = pruneRes.rowCount ?? 0;

    const adminAuditCutoffMs = Date.now() - (ADMIN_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const adminAuditPruneRes = await pool.query('DELETE FROM admin_audit_log WHERE ts < $1', [adminAuditCutoffMs]);
    const adminAuditPruned = adminAuditPruneRes.rowCount ?? 0;

    const afterRes = await pool.query<DbCountRow>('SELECT COUNT(*)::bigint as count FROM messages');
    const afterCount = toNumber(afterRes.rows[0]?.count);

    logger.info({
      pruned,
      beforeCount,
      afterCount,
      retentionDays: MESSAGE_RETENTION_DAYS,
      dialect: 'postgres',
      adminAuditPruned,
      adminAuditRetentionDays: ADMIN_AUDIT_RETENTION_DAYS,
    }, 'Database maintenance complete');

    return { pruned, beforeCount, afterCount };
  };

  const verifyLatestBackupIntegrity = async (): Promise<BackupIntegrityStatus> => {
    try {
      await pool.query('SELECT 1');
      return {
        available: true,
        path: null,
        modifiedAt: null,
        ageHours: null,
        sizeBytes: null,
        integrityOk: true,
        message: 'Postgres connectivity check passed. External backup verification is not implemented in runtime.',
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        path: null,
        modifiedAt: null,
        ageHours: null,
        sizeBytes: null,
        integrityOk: false,
        message: `Postgres connectivity check failed: ${error}`,
      };
    }
  };

  const scheduler = createMaintenanceScheduler(backupDatabase, runMaintenance);

  /**
   * Reassign positions 1..N (in the given order) for a setlist's songs.
   * Uses a negative-position intermediate pass first: setlist_songs has a
   * UNIQUE(setlist_id, position) constraint, so writing final positions
   * directly can collide with a row's current position mid-sequence.
   */
  const reassignSetlistSongPositions = async (rows: SetlistSongRow[]): Promise<void> => {
    if (rows.length === 0) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [index, row] of rows.entries()) {
        await client.query('UPDATE setlist_songs SET position = $1 WHERE id = $2', [-(index + 1), row.id]);
      }
      for (const [index, row] of rows.entries()) {
        await client.query('UPDATE setlist_songs SET position = $1 WHERE id = $2', [index + 1, row.id]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  /**
   * Reassign positions 1..N (in the given order) for a song's sections.
   * Mirrors reassignSetlistSongPositions's negative-then-final two-phase
   * transaction pattern, needed because song_sections has a
   * UNIQUE(song_id, position) constraint.
   */
  const reassignSongSectionPositions = async (rows: SongSectionRow[]): Promise<void> => {
    if (rows.length === 0) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [index, row] of rows.entries()) {
        await client.query('UPDATE song_sections SET position = $1 WHERE id = $2', [-(index + 1), row.id]);
      }
      for (const [index, row] of rows.entries()) {
        await client.query('UPDATE song_sections SET position = $1 WHERE id = $2', [index + 1, row.id]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  return {
    async touchProfile(senderJid: string): Promise<void> {
      const bare = toBareJid(senderJid);
      const now = Math.floor(Date.now() / 1000);
      await pool.query(
        `INSERT INTO member_profiles (jid, first_seen, last_seen)
         VALUES ($1, $2, $3)
         ON CONFLICT (jid) DO UPDATE SET last_seen = EXCLUDED.last_seen`,
        [bare, now, now],
      );
    },

    async getProfile(senderJid: string): Promise<MemberProfile | undefined> {
      const bare = toBareJid(senderJid);
      const res = await pool.query<ProfileRow>('SELECT * FROM member_profiles WHERE jid = $1', [bare]);
      const row = res.rows[0];
      return row ? mapMemberProfile(row) : undefined;
    },

    async setProfileInterests(senderJid: string, interests: string[]): Promise<void> {
      const bare = toBareJid(senderJid);
      await pool.query(
        'UPDATE member_profiles SET interests = $1::jsonb, opted_in = 1 WHERE jid = $2',
        [JSON.stringify(interests), bare],
      );
    },

    async setProfileName(senderJid: string, name: string): Promise<void> {
      const bare = toBareJid(senderJid);
      await pool.query('UPDATE member_profiles SET name = $1 WHERE jid = $2', [name, bare]);
    },

    async updateActiveGroups(senderJid: string, groupJid: string): Promise<void> {
      const bare = toBareJid(senderJid);
      const res = await pool.query<Pick<ProfileRow, 'groups_active'>>(
        'SELECT groups_active FROM member_profiles WHERE jid = $1',
        [bare],
      );
      const row = res.rows[0];
      if (!row) return;

      const groups = parseJsonArray(row.groups_active);
      if (groups.includes(groupJid)) return;

      groups.push(groupJid);
      await pool.query('UPDATE member_profiles SET groups_active = $1::jsonb WHERE jid = $2', [JSON.stringify(groups), bare]);
    },

    async getOptedInProfiles(): Promise<MemberProfile[]> {
      const res = await pool.query<ProfileRow>('SELECT * FROM member_profiles WHERE opted_in = 1');
      return res.rows.map(mapMemberProfile);
    },

    async deleteProfileData(senderJid: string): Promise<void> {
      const bare = toBareJid(senderJid);
      await pool.query('DELETE FROM member_profiles WHERE jid = $1', [bare]);
    },

    backupDatabase,
    runMaintenance,
    verifyLatestBackupIntegrity,
    scheduleMaintenance: scheduler.scheduleMaintenance,
    stopMaintenance: scheduler.stopMaintenance,

    async storeMessage(chatJid: string, sender: string, text: string): Promise<number> {
      const bare = toBareJid(sender);
      const truncated = text.length > 500 ? text.slice(0, 497) + '...' : text;
      const ts = Math.floor(Date.now() / 1000);

      await pool.query(
        'INSERT INTO messages (chat_jid, sender, text, timestamp) VALUES ($1, $2, $3, $4)',
        [chatJid, bare, truncated, ts],
      );

      await pool.query(
        `DELETE FROM messages
         WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY timestamp DESC, id DESC) AS row_num
             FROM messages
             WHERE chat_jid = $1
           ) ranked
           WHERE ranked.row_num > $2
         )`,
        [chatJid, MAX_MESSAGES_PER_CHAT],
      );

      await upsertConversationSession(chatJid, bare, ts);
      return ts;
    },

    async getMessages(chatJid: string, limit: number = 15): Promise<DbMessage[]> {
      const res = await pool.query<MessageRow>(
        'SELECT sender, text, timestamp FROM messages WHERE chat_jid = $1 ORDER BY timestamp DESC, id DESC LIMIT $2',
        [chatJid, limit],
      );
      return res.rows.map(mapDbMessage).reverse();
    },

    async listMessageChatJids(): Promise<string[]> {
      const res = await pool.query<{ chat_jid: string }>('SELECT DISTINCT chat_jid FROM messages');
      return res.rows.map((row) => row.chat_jid);
    },

    async listSummarizedSessions(limit: number = Number.MAX_SAFE_INTEGER): Promise<BackfillSession[]> {
      const res = await pool.query<SessionSummaryRow & { chat_jid: string }>(
        `SELECT id, chat_jid, started_at, ended_at, message_count, participants, summary_text, topic_tags
         FROM conversation_sessions
         WHERE status = 'summarized' AND summary_text IS NOT NULL
         ORDER BY ended_at DESC, id DESC
         LIMIT $1`,
        [limit],
      );
      return res.rows.map((row) => ({
        sessionId: toNumber(row.id),
        chatJid: row.chat_jid,
        startedAt: toNumber(row.started_at),
        endedAt: toNumber(row.ended_at),
        messageCount: toNumber(row.message_count),
        participants: parseJsonArray(row.participants),
        topicTags: parseJsonArray(row.topic_tags),
        summaryText: row.summary_text,
      }));
    },

    async searchRelevantMessages(chatJid: string, query: string, limit: number = CONTEXT_RELEVANT_LIMIT): Promise<DbMessage[]> {
      const trimmed = query.trim();
      if (!trimmed) return [];

      const directResults = await pool.query<MessageRow>(
        `SELECT sender, text, timestamp
         FROM messages
         WHERE chat_jid = $1 AND text ILIKE $2
         ORDER BY timestamp DESC, id DESC
         LIMIT $3`,
        [chatJid, `%${trimmed}%`, limit],
      );

      if (directResults.rows.length > 0) {
        return directResults.rows.map(mapDbMessage);
      }

      const terms = extractSearchTerms(trimmed);
      const seen = new Set<string>();
      const matches: DbMessage[] = [];

      for (const term of terms) {
        const res = await pool.query<MessageRow>(
          `SELECT sender, text, timestamp
           FROM messages
           WHERE chat_jid = $1 AND text ILIKE $2
           ORDER BY timestamp DESC, id DESC
           LIMIT $3`,
          [chatJid, `%${term}%`, limit],
        );

        for (const row of res.rows) {
          const mapped = mapDbMessage(row);
          const key = `${mapped.timestamp}:${mapped.sender}:${mapped.text}`;
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push(mapped);
          if (matches.length >= limit) return matches;
        }
      }

      return matches;
    },

    async searchRelevantSessionSummaries(
      chatJid: string,
      query: string,
      limit: number = config.CONTEXT_SESSION_MAX_RETRIEVED,
    ): Promise<SessionSummaryHit[]> {
      if (!config.CONTEXT_SESSION_MEMORY_ENABLED) return [];

      const trimmed = query.trim();
      if (!trimmed) return [];

      const candidates = await pool.query<SessionSummaryRow>(
        `SELECT id, started_at, ended_at, message_count, participants, summary_text, topic_tags
         FROM conversation_sessions
         WHERE chat_jid = $1 AND status = 'summarized' AND summary_text IS NOT NULL
         ORDER BY ended_at DESC
         LIMIT $2`,
        [chatJid, Math.max(limit * 4, 12)],
      );

      return candidates.rows
        .map((row) => {
          const topicTags = parseJsonArray(row.topic_tags);
          const summaryText = row.summary_text;
          return mapSessionSummaryHit(row, scoreSessionMatch(summaryText, topicTags, trimmed, toNumber(row.ended_at)));
        })
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    async logModeration(entry: ModerationEntry): Promise<void> {
      await pool.query(
        `INSERT INTO moderation_log (chat_jid, sender, text, reason, severity, source, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [entry.chatJid, entry.sender, entry.text, entry.reason, entry.severity, entry.source, entry.timestamp],
      );
    },

    async getStrikeCount(senderJid: string): Promise<number> {
      const bare = toBareJid(senderJid);
      const res = await pool.query<DbCountRow>('SELECT COUNT(*)::bigint as count FROM moderation_log WHERE sender = $1', [bare]);
      return toNumber(res.rows[0]?.count);
    },

    async getRepeatOffenders(minStrikes: number = 3): Promise<StrikeSummary[]> {
      const res = await pool.query<StrikeSummaryRow>(
        `SELECT
           sender,
           COUNT(*)::bigint AS strike_count,
           MAX(timestamp)::bigint AS last_flag,
           STRING_AGG(DISTINCT reason, ', ') AS reasons
         FROM moderation_log
         GROUP BY sender
         HAVING COUNT(*) >= $1
         ORDER BY strike_count DESC`,
        [minStrikes],
      );

      return res.rows.map(mapStrikeSummary);
    },

    async saveDailyStats(date: string, json: string): Promise<void> {
      await pool.query(
        `INSERT INTO daily_stats (date, data)
         VALUES ($1, $2)
         ON CONFLICT (date) DO UPDATE SET data = EXCLUDED.data`,
        [date, json],
      );
    },

    async loadDailyStatsRange(fromDate: string, toDate: string): Promise<Array<{ date: string; data: string }>> {
      const result = await pool.query(
        `SELECT date, data FROM daily_stats WHERE date >= $1 AND date <= $2 ORDER BY date ASC`,
        [fromDate, toDate],
      );
      return result.rows as Array<{ date: string; data: string }>;
    },

    async getDailyGroupActivity(date: string): Promise<DailyGroupActivity[]> {
      const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10));
      if (!year || !month || !day) return [];

      const start = new Date(year, month - 1, day, 0, 0, 0, 0);
      const end = new Date(year, month - 1, day, 23, 59, 59, 999);

      const res = await pool.query<DailyGroupActivityRow>(
        `SELECT
           chat_jid AS chatJid,
           COUNT(*)::bigint AS messageCount,
           COUNT(DISTINCT sender)::bigint AS activeUsers
         FROM messages
         WHERE timestamp >= $1 AND timestamp <= $2
         GROUP BY chat_jid
         ORDER BY messageCount DESC`,
        [Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000)],
      );

      return res.rows.map(mapDailyGroupActivity);
    },

    async addEventReminder(input: NewEventReminder): Promise<EventReminder> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<EventReminderRow>(
        `INSERT INTO event_reminders
         (chat_jid, activity, location, event_at, remind_at, created_by, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
         RETURNING *`,
        [
          input.chatJid,
          input.activity,
          input.location,
          input.eventAt,
          input.remindAt,
          input.createdBy,
          ts,
        ],
      );
      return mapEventReminder(res.rows[0]);
    },

    async listPendingEventReminders(nowSeconds: number): Promise<EventReminder[]> {
      const res = await pool.query<EventReminderRow>(
        `SELECT * FROM event_reminders
         WHERE status = 'pending' AND remind_at <= $1
         ORDER BY remind_at ASC, id ASC`,
        [nowSeconds],
      );
      return res.rows.map(mapEventReminder);
    },

    async listUpcomingEventReminders(limit: number = 20): Promise<EventReminder[]> {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const res = await pool.query<EventReminderRow>(
        `SELECT * FROM event_reminders
         WHERE status = 'pending' AND event_at >= $1
         ORDER BY event_at ASC, id ASC
         LIMIT $2`,
        [nowSeconds, limit],
      );
      return res.rows.map(mapEventReminder);
    },

    async markEventReminderSent(id: number): Promise<boolean> {
      const res = await pool.query(
        "UPDATE event_reminders SET status = 'sent' WHERE id = $1 AND status = 'pending'",
        [id],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async cancelEventReminder(id: number): Promise<boolean> {
      const res = await pool.query(
        "UPDATE event_reminders SET status = 'cancelled' WHERE id = $1 AND status = 'pending'",
        [id],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async rescheduleEventReminder(id: number, eventAt: number, remindAt: number): Promise<boolean> {
      const res = await pool.query(
        "UPDATE event_reminders SET event_at = $2, remind_at = $3 WHERE id = $1 AND status = 'pending'",
        [id, eventAt, remindAt],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async renameEventReminder(id: number, activity: string): Promise<boolean> {
      const res = await pool.query(
        "UPDATE event_reminders SET activity = $2 WHERE id = $1 AND status = 'pending'",
        [id, activity],
      );
      return (res.rowCount ?? 0) > 0;
    },

    // Native platform events follow the bridge-outbox precedent: sqlite is
    // the implemented backend; postgres throws until ported.
    async addNativeEvent(): Promise<never> {
      throw new Error('Native events are not implemented for postgres backend yet');
    },

    async getNativeEventById(): Promise<never> {
      throw new Error('Native events are not implemented for postgres backend yet');
    },

    async listUpcomingNativeEvents(): Promise<never> {
      throw new Error('Native events are not implemented for postgres backend yet');
    },

    async updateNativeEvent(): Promise<never> {
      throw new Error('Native events are not implemented for postgres backend yet');
    },

    async findWhatsAppNativeEventByMessageId(): Promise<never> {
      throw new Error('Native events are not implemented for postgres backend yet');
    },

    async reconcileHeldNativeEventRef(): Promise<never> {
      throw new Error('Native events are not implemented for postgres backend yet');
    },

    async upsertNativeEventRsvp(): Promise<never> {
      throw new Error('Native events are not implemented for postgres backend yet');
    },

    async listNativeEventRsvps(): Promise<never> {
      throw new Error('Native events are not implemented for postgres backend yet');
    },

    async countNativeEventRsvps(): Promise<never> {
      throw new Error('Native events are not implemented for postgres backend yet');
    },

    async createWhatsAppOutboundJob(
      chatJid: string,
      kind: string,
      contentJson: string,
      optionsJson: string | null,
    ): Promise<WhatsAppOutboundJob> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<WhatsAppOutboundRow>(
        `INSERT INTO whatsapp_outbound_jobs
         (chat_jid, kind, content_json, options_json, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $5)
         RETURNING *`,
        [chatJid, kind, contentJson, optionsJson, ts],
      );
      return mapWhatsAppOutboundJob(res.rows[0]);
    },

    async updateWhatsAppOutboundJob(
      id: number,
      status: WhatsAppOutboundStatus,
      reason: string | null = null,
      sentAt: number | null = null,
      contentJson?: string,
    ): Promise<boolean> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query(
        `UPDATE whatsapp_outbound_jobs
         SET status = $1, reason = $2, attempts = attempts + 1, updated_at = $3,
             sent_at = $4, content_json = COALESCE($5, content_json)
         WHERE id = $6`,
        [status, reason, ts, sentAt, contentJson ?? null, id],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async getWhatsAppOutboundJob(id: number): Promise<WhatsAppOutboundJob | undefined> {
      const res = await pool.query<WhatsAppOutboundRow>(
        'SELECT * FROM whatsapp_outbound_jobs WHERE id = $1',
        [id],
      );
      const row = res.rows[0];
      return row ? mapWhatsAppOutboundJob(row) : undefined;
    },

    async listWhatsAppHeldJobs(limit: number = 20): Promise<WhatsAppOutboundJob[]> {
      const res = await pool.query<WhatsAppOutboundRow>(
        `SELECT * FROM whatsapp_outbound_jobs
         WHERE status = 'held' ORDER BY created_at ASC, id ASC LIMIT $1`,
        [limit],
      );
      return res.rows.map(mapWhatsAppOutboundJob);
    },

    async recoverWhatsAppPendingJobs(reason: string): Promise<number> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query(
        `UPDATE whatsapp_outbound_jobs SET status = 'held', reason = $1, updated_at = $2
         WHERE status = 'pending'`,
        [reason, ts],
      );
      return res.rowCount ?? 0;
    },

    async countWhatsAppSentSince(since: number): Promise<number> {
      const res = await pool.query<DbCountRow>(
        `SELECT COUNT(*)::bigint AS count FROM whatsapp_outbound_jobs
         WHERE status = 'sent' AND sent_at >= $1`,
        [since],
      );
      return toNumber(res.rows[0]?.count);
    },

    async getWhatsAppSafetyState(): Promise<WhatsAppSafetyState> {
      const res = await pool.query<WhatsAppSafetyStateRow>(
        'SELECT paused, risk, score, reasons, updated_at FROM whatsapp_safety_state WHERE id = 1',
      );
      return mapWhatsAppSafetyState(res.rows[0]);
    },

    async setWhatsAppSafetyState(
      paused: boolean,
      risk: WhatsAppRiskLevel,
      score: number,
      reasons: string[],
    ): Promise<void> {
      const ts = Math.floor(Date.now() / 1000);
      await pool.query(
        `INSERT INTO whatsapp_safety_state (id, paused, risk, score, reasons, updated_at)
         VALUES (1, $1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (id) DO UPDATE SET
           paused = EXCLUDED.paused,
           risk = EXCLUDED.risk,
           score = EXCLUDED.score,
           reasons = EXCLUDED.reasons,
           updated_at = EXCLUDED.updated_at`,
        [paused ? 1 : 0, risk, score, JSON.stringify(reasons), ts],
      );
    },

    async getWhatsAppSafetyMetrics(hourSince: number, daySince: number): Promise<WhatsAppSafetyMetrics> {
      const counts = await pool.query<WhatsAppMetricCountsLike>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pending')::bigint AS pending,
           COUNT(*) FILTER (WHERE status = 'held')::bigint AS held,
           COUNT(*) FILTER (WHERE status = 'sent' AND sent_at >= $1)::bigint AS sent_last_hour,
           COUNT(*) FILTER (WHERE status = 'sent' AND sent_at >= $2)::bigint AS sent_last_day,
           COUNT(*) FILTER (WHERE status = 'failed' AND updated_at >= $1)::bigint AS failed_last_hour
         FROM whatsapp_outbound_jobs`,
        [hourSince, daySince],
      );
      const safetyState = await pool.query<WhatsAppSafetyStateRow>(
        'SELECT paused, risk, score, reasons, updated_at FROM whatsapp_safety_state WHERE id = 1',
      );
      const state = mapWhatsAppSafetyState(safetyState.rows[0]);
      return mapWhatsAppSafetyMetrics(counts.rows[0], state);
    },

    async enqueueBridgeOutbox(_envelope: BridgeEnvelope): Promise<BridgeOutboxEntry> {
      throw new Error('Bridge outbox is not implemented for postgres backend yet');
    },

    async claimDueBridgeOutbox(_limit: number): Promise<BridgeOutboxEntry[]> {
      throw new Error('Bridge outbox is not implemented for postgres backend yet');
    },

    async markBridgeOutboxSent(_id: number): Promise<boolean> {
      throw new Error('Bridge outbox is not implemented for postgres backend yet');
    },

    async markBridgeOutboxDead(_id: number, _error: string): Promise<boolean> {
      throw new Error('Bridge outbox is not implemented for postgres backend yet');
    },

    async bumpBridgeOutboxAttempt(_id: number, _nextAt: number, _error: string): Promise<boolean> {
      throw new Error('Bridge outbox is not implemented for postgres backend yet');
    },

    async deferBridgeOutbox(_id: number, _nextAt: number, _error: string): Promise<boolean> {
      throw new Error('Bridge outbox is not implemented for postgres backend yet');
    },

    async bridgeSeenInsert(_key: string): Promise<boolean> {
      throw new Error('Bridge deduplication is not implemented for postgres backend yet');
    },

    async bridgeSeenDelete(_key: string): Promise<boolean> {
      throw new Error('Bridge deduplication is not implemented for postgres backend yet');
    },

    async bridgeOutboxCounts(): Promise<BridgeOutboxCounts> {
      throw new Error('Bridge outbox is not implemented for postgres backend yet');
    },

    async appendBridgeBuffer(_routeId: string, _envelopeJson: string): Promise<void> {
      throw new Error('Bridge summary buffer is not implemented for postgres backend yet');
    },

    async takeBridgeBuffer(_routeId: string): Promise<BridgeBufferEntry[]> {
      throw new Error('Bridge summary buffer is not implemented for postgres backend yet');
    },

    async restoreBridgeBuffer(_rows: BridgeBufferEntry[]): Promise<void> {
      throw new Error('Bridge summary buffer is not implemented for postgres backend yet');
    },

    async bridgeBufferDepths(): Promise<Record<string, number>> {
      throw new Error('Bridge summary buffer is not implemented for postgres backend yet');
    },

    async submitFeedback(
      type: 'suggestion' | 'bug',
      sender: string,
      groupJid: string | null,
      text: string,
    ): Promise<FeedbackEntry> {
      const bare = toBareJid(sender);
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<FeedbackRow>(
        `INSERT INTO feedback (type, sender, group_jid, text, status, upvotes, upvoters, timestamp)
         VALUES ($1, $2, $3, $4, 'open', 0, '[]'::jsonb, $5)
         RETURNING *`,
        [type, bare, groupJid, text, ts],
      );

      return mapFeedbackEntry(res.rows[0]);
    },

    async getOpenFeedback(): Promise<FeedbackEntry[]> {
      const res = await pool.query<FeedbackRow>(
        "SELECT * FROM feedback WHERE status = 'open' ORDER BY upvotes DESC, timestamp ASC",
      );
      return res.rows.map(mapFeedbackEntry);
    },

    async getRecentFeedback(limit: number = 20): Promise<FeedbackEntry[]> {
      const res = await pool.query<FeedbackRow>(
        'SELECT * FROM feedback ORDER BY timestamp DESC LIMIT $1',
        [limit],
      );
      return res.rows.map(mapFeedbackEntry);
    },

    async getFeedbackById(id: number): Promise<FeedbackEntry | undefined> {
      const res = await pool.query<FeedbackRow>('SELECT * FROM feedback WHERE id = $1', [id]);
      const row = res.rows[0];
      return row ? mapFeedbackEntry(row) : undefined;
    },

    async setFeedbackStatus(id: number, status: 'open' | 'accepted' | 'rejected' | 'done'): Promise<boolean> {
      const res = await pool.query('UPDATE feedback SET status = $1 WHERE id = $2', [status, id]);
      return (res.rowCount ?? 0) > 0;
    },

    async upvoteFeedback(id: number, senderJid: string): Promise<boolean> {
      const bare = toBareJid(senderJid);
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        const existing = await client.query<Pick<FeedbackRow, 'upvotes' | 'upvoters'>>(
          'SELECT upvotes, upvoters FROM feedback WHERE id = $1 FOR UPDATE',
          [id],
        );

        const row = existing.rows[0];
        if (!row) {
          await client.query('ROLLBACK');
          return false;
        }

        const voters = parseJsonArray(row.upvoters);
        if (voters.includes(bare)) {
          await client.query('COMMIT');
          return false;
        }

        voters.push(bare);
        const currentUpvotes = toNumber(row.upvotes);

        await client.query(
          'UPDATE feedback SET upvotes = $1, upvoters = $2::jsonb WHERE id = $3',
          [currentUpvotes + 1, JSON.stringify(voters), id],
        );

        await client.query('COMMIT');
        return true;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async linkFeedbackToGitHubIssue(id: number, issueNumber: number, issueUrl: string): Promise<boolean> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query(
        `UPDATE feedback
         SET github_issue_number = $1, github_issue_url = $2, github_issue_created_at = $3
         WHERE id = $4`,
        [issueNumber, issueUrl, ts, id],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async addMemory(fact: string, category: string = 'general', source: string = 'owner'): Promise<LocalMemoryEntry> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<MemoryRow>(
        `INSERT INTO memory (fact, category, source, created_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [fact, category, source, ts],
      );

      return mapMemoryEntry(res.rows[0]);
    },

    async getAllMemories(): Promise<LocalMemoryEntry[]> {
      const res = await pool.query<MemoryRow>('SELECT * FROM memory ORDER BY category, created_at DESC');
      return res.rows.map(mapMemoryEntry);
    },

    async deleteMemory(id: number): Promise<boolean> {
      const res = await pool.query('DELETE FROM memory WHERE id = $1', [id]);
      return (res.rowCount ?? 0) > 0;
    },

    async deleteMemoryWithAudit(id: number, entry: AdminAuditLogInput): Promise<boolean> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const deleted = await client.query('DELETE FROM memory WHERE id = $1', [id]);
        if ((deleted.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query(
          `INSERT INTO admin_audit_log (ts, action, target, summary, source_ip)
           VALUES ($1, $2, $3, $4, $5)`,
          [entry.ts, entry.action, entry.target, entry.summary, entry.sourceIp],
        );
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async addAdminAuditLog(entry: AdminAuditLogInput): Promise<AdminAuditLogEntry> {
      const res = await pool.query<{
        id: number | string;
        ts: number | string;
        action: string;
        target: string;
        summary: string;
        source_ip: string;
      }>(
        `INSERT INTO admin_audit_log (ts, action, target, summary, source_ip)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, ts, action, target, summary, source_ip`,
        [entry.ts, entry.action, entry.target, entry.summary, entry.sourceIp],
      );
      const row = res.rows[0];
      return {
        id: toNumber(row.id),
        ts: toNumber(row.ts),
        action: row.action,
        target: row.target,
        summary: row.summary,
        sourceIp: row.source_ip,
      };
    },

    async getAdminAuditLog(limit = 100): Promise<AdminAuditLogEntry[]> {
      const res = await pool.query<{
        id: number | string;
        ts: number | string;
        action: string;
        target: string;
        summary: string;
        source_ip: string;
      }>(
        `SELECT id, ts, action, target, summary, source_ip
         FROM admin_audit_log ORDER BY ts DESC, id DESC LIMIT $1`,
        [limit],
      );
      return res.rows.map((row) => ({
        id: toNumber(row.id),
        ts: toNumber(row.ts),
        action: row.action,
        target: row.target,
        summary: row.summary,
        sourceIp: row.source_ip,
      }));
    },

    async searchMemory(keyword: string, limit: number = 10): Promise<MemoryEntry[]> {
      const res = await pool.query<MemoryRow>(
        'SELECT * FROM memory WHERE fact ILIKE $1 ORDER BY created_at DESC LIMIT $2',
        [`%${keyword}%`, limit],
      );
      return res.rows.map(mapMemoryEntry);
    },

    async formatMemoriesForPrompt(): Promise<string> {
      const res = await pool.query<MemoryRow>('SELECT * FROM memory ORDER BY category, created_at DESC');
      const memories = res.rows.map(mapMemoryEntry);
      return formatMemoriesForPromptEntries(memories);
    },

    async addSong(input: {
      title: string;
      key?: string | null;
      tempo?: number | null;
      status?: SongStatus;
      notes?: string | null;
    }): Promise<Song> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<SongRow>(
        `INSERT INTO songs (title, song_key, tempo, status, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING *`,
        [input.title, input.key ?? null, input.tempo ?? null, input.status ?? 'idea', input.notes ?? null, ts],
      );
      return mapSong(res.rows[0]);
    },

    async getSongById(id: number): Promise<Song | undefined> {
      const res = await pool.query<SongRow>('SELECT * FROM songs WHERE id = $1', [id]);
      const row = res.rows[0];
      return row ? mapSong(row) : undefined;
    },

    async getSongByTitle(title: string): Promise<Song | undefined> {
      const res = await pool.query<SongRow>('SELECT * FROM songs WHERE lower(title) = lower($1)', [title]);
      const row = res.rows[0];
      return row ? mapSong(row) : undefined;
    },

    async listSongs(status?: SongStatus): Promise<Song[]> {
      const res = status
        ? await pool.query<SongRow>('SELECT * FROM songs WHERE status = $1 ORDER BY title ASC', [status])
        : await pool.query<SongRow>('SELECT * FROM songs ORDER BY title ASC');
      return res.rows.map(mapSong);
    },

    async updateSong(
      id: number,
      patch: Partial<{ title: string; key: string | null; tempo: number | null; status: SongStatus; notes: string | null }>,
    ): Promise<Song | undefined> {
      const existingRes = await pool.query<SongRow>('SELECT * FROM songs WHERE id = $1', [id]);
      const existing = existingRes.rows[0];
      if (!existing) return undefined;

      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<SongRow>(
        `UPDATE songs
         SET title = $1, song_key = $2, tempo = $3, status = $4, notes = $5, updated_at = $6
         WHERE id = $7
         RETURNING *`,
        [
          patch.title ?? existing.title,
          patch.key !== undefined ? patch.key : existing.song_key,
          patch.tempo !== undefined ? patch.tempo : existing.tempo,
          patch.status ?? existing.status,
          patch.notes !== undefined ? patch.notes : existing.notes,
          ts,
          id,
        ],
      );
      return mapSong(res.rows[0]);
    },

    async deleteSong(id: number): Promise<boolean> {
      await pool.query('DELETE FROM setlist_songs WHERE song_id = $1', [id]);
      await pool.query('DELETE FROM song_sections WHERE song_id = $1', [id]);
      await pool.query('UPDATE song_ideas SET song_id = NULL WHERE song_id = $1', [id]);
      const res = await pool.query('DELETE FROM songs WHERE id = $1', [id]);
      return (res.rowCount ?? 0) > 0;
    },

    async addSongIdea(input: {
      title?: string | null;
      text?: string | null;
      audioUrl?: string | null;
      transcript?: string | null;
      songId?: number | null;
      createdBy?: string | null;
    }): Promise<SongIdea> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<SongIdeaRow>(
        `INSERT INTO song_ideas (title, text, audio_url, transcript, song_id, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          input.title ?? null,
          input.text ?? null,
          input.audioUrl ?? null,
          input.transcript ?? null,
          input.songId ?? null,
          input.createdBy ?? null,
          ts,
        ],
      );
      return mapSongIdea(res.rows[0]);
    },

    async getSongIdeaById(id: number): Promise<SongIdea | undefined> {
      const res = await pool.query<SongIdeaRow>('SELECT * FROM song_ideas WHERE id = $1', [id]);
      const row = res.rows[0];
      return row ? mapSongIdea(row) : undefined;
    },

    async listSongIdeas(limit?: number): Promise<SongIdea[]> {
      const res = limit !== undefined
        ? await pool.query<SongIdeaRow>(
          'SELECT * FROM song_ideas ORDER BY created_at DESC, id DESC LIMIT $1',
          [limit],
        )
        : await pool.query<SongIdeaRow>('SELECT * FROM song_ideas ORDER BY created_at DESC, id DESC');
      return res.rows.map(mapSongIdea);
    },

    async linkSongIdeaToSong(ideaId: number, songId: number): Promise<boolean> {
      const res = await pool.query('UPDATE song_ideas SET song_id = $1 WHERE id = $2', [songId, ideaId]);
      return (res.rowCount ?? 0) > 0;
    },

    async deleteSongIdea(id: number): Promise<boolean> {
      const res = await pool.query('DELETE FROM song_ideas WHERE id = $1', [id]);
      return (res.rowCount ?? 0) > 0;
    },

    async addRehearsal(input: {
      scheduledAt: number;
      location?: string | null;
      agenda?: string | null;
      createdBy?: string | null;
    }): Promise<Rehearsal> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<RehearsalRow>(
        `INSERT INTO rehearsals (scheduled_at, location, agenda, status, reminder_sent, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'scheduled', false, $4, $5, $5)
         RETURNING *`,
        [input.scheduledAt, input.location ?? null, input.agenda ?? null, input.createdBy ?? null, ts],
      );
      return mapRehearsal(res.rows[0]);
    },

    async getRehearsalById(id: number): Promise<Rehearsal | undefined> {
      const res = await pool.query<RehearsalRow>('SELECT * FROM rehearsals WHERE id = $1', [id]);
      const row = res.rows[0];
      return row ? mapRehearsal(row) : undefined;
    },

    async listUpcomingRehearsals(nowSeconds: number, limit: number = 20): Promise<Rehearsal[]> {
      const res = await pool.query<RehearsalRow>(
        `SELECT * FROM rehearsals
         WHERE status = 'scheduled' AND scheduled_at >= $1
         ORDER BY scheduled_at ASC
         LIMIT $2`,
        [nowSeconds, limit],
      );
      return res.rows.map(mapRehearsal);
    },

    async getNextRehearsal(nowSeconds: number): Promise<Rehearsal | undefined> {
      const res = await pool.query<RehearsalRow>(
        `SELECT * FROM rehearsals
         WHERE status = 'scheduled' AND scheduled_at >= $1
         ORDER BY scheduled_at ASC
         LIMIT 1`,
        [nowSeconds],
      );
      const row = res.rows[0];
      return row ? mapRehearsal(row) : undefined;
    },

    async updateRehearsal(
      id: number,
      patch: Partial<{ scheduledAt: number; location: string | null; agenda: string | null; status: RehearsalStatus }>,
    ): Promise<Rehearsal | undefined> {
      const existingRes = await pool.query<RehearsalRow>('SELECT * FROM rehearsals WHERE id = $1', [id]);
      const existing = existingRes.rows[0];
      if (!existing) return undefined;

      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<RehearsalRow>(
        `UPDATE rehearsals
         SET scheduled_at = $1, location = $2, agenda = $3, status = $4, updated_at = $5
         WHERE id = $6
         RETURNING *`,
        [
          patch.scheduledAt ?? existing.scheduled_at,
          patch.location !== undefined ? patch.location : existing.location,
          patch.agenda !== undefined ? patch.agenda : existing.agenda,
          patch.status ?? existing.status,
          ts,
          id,
        ],
      );
      return mapRehearsal(res.rows[0]);
    },

    async cancelRehearsal(id: number): Promise<boolean> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query(
        "UPDATE rehearsals SET status = 'cancelled', updated_at = $1 WHERE id = $2",
        [ts, id],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async listRehearsalsNeedingReminder(nowSeconds: number): Promise<Rehearsal[]> {
      const leadSeconds = config.REHEARSAL_REMINDER_LEAD_MINUTES * 60;
      const res = await pool.query<RehearsalRow>(
        `SELECT * FROM rehearsals
         WHERE status = 'scheduled'
           AND reminder_sent = false
           AND (scheduled_at - $1) <= $2
           AND $2 < scheduled_at
         ORDER BY scheduled_at ASC`,
        [leadSeconds, nowSeconds],
      );
      return res.rows.map(mapRehearsal);
    },

    async markRehearsalReminderSent(id: number): Promise<boolean> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query(
        'UPDATE rehearsals SET reminder_sent = true, updated_at = $1 WHERE id = $2',
        [ts, id],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async setAvailability(
      rehearsalId: number,
      memberId: string,
      memberName: string | null,
      response: AvailabilityResponse,
    ): Promise<Availability> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<AvailabilityRow>(
        `INSERT INTO availability (rehearsal_id, member_id, member_name, response, responded_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (rehearsal_id, member_id) DO UPDATE SET
           response = EXCLUDED.response,
           member_name = EXCLUDED.member_name,
           responded_at = EXCLUDED.responded_at
         RETURNING *`,
        [rehearsalId, memberId, memberName, response, ts],
      );
      return mapAvailability(res.rows[0]);
    },

    async listAvailability(rehearsalId: number): Promise<Availability[]> {
      const res = await pool.query<AvailabilityRow>(
        `SELECT * FROM availability WHERE rehearsal_id = $1 ORDER BY response ASC, responded_at ASC`,
        [rehearsalId],
      );
      return res.rows.map(mapAvailability);
    },

    async addSetlist(input: { name: string; notes?: string | null }): Promise<Setlist> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<SetlistRow>(
        `INSERT INTO setlists (name, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $3)
         RETURNING *`,
        [input.name, input.notes ?? null, ts],
      );
      return mapSetlist(res.rows[0]);
    },

    async getSetlistByName(name: string): Promise<Setlist | undefined> {
      const res = await pool.query<SetlistRow>('SELECT * FROM setlists WHERE lower(name) = lower($1)', [name]);
      const row = res.rows[0];
      return row ? mapSetlist(row) : undefined;
    },

    async listSetlists(): Promise<Setlist[]> {
      const res = await pool.query<SetlistRow>('SELECT * FROM setlists ORDER BY name ASC');
      return res.rows.map(mapSetlist);
    },

    async deleteSetlist(id: number): Promise<boolean> {
      await pool.query('DELETE FROM setlist_songs WHERE setlist_id = $1', [id]);
      const res = await pool.query('DELETE FROM setlists WHERE id = $1', [id]);
      return (res.rowCount ?? 0) > 0;
    },

    async addSongToSetlist(setlistId: number, songId: number, position?: number): Promise<SetlistSong> {
      let pos = position;
      if (pos === undefined) {
        const maxRes = await pool.query<{ maxposition: DbNumeric | null }>(
          'SELECT MAX(position) AS maxposition FROM setlist_songs WHERE setlist_id = $1',
          [setlistId],
        );
        pos = toNumber(maxRes.rows[0]?.maxposition ?? 0) + 1;
      }
      const res = await pool.query<SetlistSongRow>(
        `INSERT INTO setlist_songs (setlist_id, song_id, position)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [setlistId, songId, pos],
      );
      return mapSetlistSong(res.rows[0]);
    },

    async removeSongFromSetlist(setlistId: number, songId: number): Promise<boolean> {
      const res = await pool.query(
        'DELETE FROM setlist_songs WHERE setlist_id = $1 AND song_id = $2',
        [setlistId, songId],
      );
      const removed = (res.rowCount ?? 0) > 0;
      if (removed) {
        const rowsRes = await pool.query<SetlistSongRow>(
          'SELECT * FROM setlist_songs WHERE setlist_id = $1 ORDER BY position ASC',
          [setlistId],
        );
        await reassignSetlistSongPositions(rowsRes.rows);
      }
      return removed;
    },

    async moveSetlistSong(setlistId: number, songId: number, newPosition: number): Promise<boolean> {
      const targetRes = await pool.query<SetlistSongRow>(
        'SELECT * FROM setlist_songs WHERE setlist_id = $1 AND song_id = $2',
        [setlistId, songId],
      );
      const target = targetRes.rows[0];
      if (!target) return false;

      const allRes = await pool.query<SetlistSongRow>(
        'SELECT * FROM setlist_songs WHERE setlist_id = $1 ORDER BY position ASC',
        [setlistId],
      );
      const rows = allRes.rows;
      const clampedPosition = Math.max(1, Math.min(newPosition, rows.length));
      const reordered = rows.filter((row) => toNumber(row.id) !== toNumber(target.id));
      reordered.splice(clampedPosition - 1, 0, target);

      await reassignSetlistSongPositions(reordered);
      return true;
    },

    async getSetlistSongs(setlistId: number): Promise<SetlistEntry[]> {
      const res = await pool.query<SetlistEntryRow>(
        `SELECT setlist_songs.position AS position, songs.*
         FROM setlist_songs
         JOIN songs ON songs.id = setlist_songs.song_id
         WHERE setlist_songs.setlist_id = $1
         ORDER BY setlist_songs.position ASC`,
        [setlistId],
      );
      return res.rows.map(mapSetlistEntry);
    },

    async addSongSection(input: {
      songId: number;
      kind: SectionKind;
      lyrics?: string | null;
      chords?: string | null;
      position?: number;
    }): Promise<SongSection> {
      let pos = input.position;
      if (pos === undefined) {
        const maxRes = await pool.query<{ maxposition: DbNumeric | null }>(
          'SELECT MAX(position) AS maxposition FROM song_sections WHERE song_id = $1',
          [input.songId],
        );
        pos = toNumber(maxRes.rows[0]?.maxposition ?? 0) + 1;
      }
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<SongSectionRow>(
        `INSERT INTO song_sections (song_id, kind, position, lyrics, chords, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING *`,
        [input.songId, input.kind, pos, input.lyrics ?? null, input.chords ?? null, ts],
      );
      return mapSongSection(res.rows[0]);
    },

    async getSongSections(songId: number): Promise<SongSection[]> {
      const res = await pool.query<SongSectionRow>(
        'SELECT * FROM song_sections WHERE song_id = $1 ORDER BY position ASC',
        [songId],
      );
      return res.rows.map(mapSongSection);
    },

    async updateSongSection(
      id: number,
      patch: Partial<{ kind: SectionKind; lyrics: string | null; chords: string | null }>,
    ): Promise<SongSection | undefined> {
      const existingRes = await pool.query<SongSectionRow>('SELECT * FROM song_sections WHERE id = $1', [id]);
      const existing = existingRes.rows[0];
      if (!existing) return undefined;

      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<SongSectionRow>(
        `UPDATE song_sections
         SET kind = $1, lyrics = $2, chords = $3, updated_at = $4
         WHERE id = $5
         RETURNING *`,
        [
          patch.kind ?? existing.kind,
          patch.lyrics !== undefined ? patch.lyrics : existing.lyrics,
          patch.chords !== undefined ? patch.chords : existing.chords,
          ts,
          id,
        ],
      );
      return mapSongSection(res.rows[0]);
    },

    async moveSongSection(id: number, newPosition: number): Promise<boolean> {
      const targetRes = await pool.query<SongSectionRow>('SELECT * FROM song_sections WHERE id = $1', [id]);
      const target = targetRes.rows[0];
      if (!target) return false;

      const allRes = await pool.query<SongSectionRow>(
        'SELECT * FROM song_sections WHERE song_id = $1 ORDER BY position ASC',
        [target.song_id],
      );
      const rows = allRes.rows;
      const clampedPosition = Math.max(1, Math.min(newPosition, rows.length));
      const reordered = rows.filter((row) => toNumber(row.id) !== toNumber(target.id));
      reordered.splice(clampedPosition - 1, 0, target);

      await reassignSongSectionPositions(reordered);
      return true;
    },

    async removeSongSection(id: number): Promise<boolean> {
      const targetRes = await pool.query<SongSectionRow>('SELECT * FROM song_sections WHERE id = $1', [id]);
      const target = targetRes.rows[0];
      if (!target) return false;

      const res = await pool.query('DELETE FROM song_sections WHERE id = $1', [id]);
      const removed = (res.rowCount ?? 0) > 0;
      if (removed) {
        const rowsRes = await pool.query<SongSectionRow>(
          'SELECT * FROM song_sections WHERE song_id = $1 ORDER BY position ASC',
          [target.song_id],
        );
        await reassignSongSectionPositions(rowsRes.rows);
      }
      return removed;
    },

    async closeDb(): Promise<void> {
      scheduler.stopMaintenance();
      await pool.end();
      logger.info('Postgres database pool closed');
    },
  };
}
