import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

import { logger } from '../middleware/logger.js';
import { recordSessionEmbedding, recordSessionSummaryLifecycle } from '../middleware/stats.js';
import { PROJECT_ROOT, config } from './config.js';
import { embedTextDeterministic, toPgvectorLiteral } from './text-embedding.js';
import { embedTextForVectorSearch } from './embedding-provider.js';
import { summarizeSession, scoreSessionMatch, buildContextualizedEmbeddingInput } from './session-summary.js';
import type { DbBackend } from './db-backend.js';
import {
  mapDailyGroupActivity,
  mapDbMessage,
  mapFeedbackEntry,
  mapMemoryEntry,
  mapMemberProfile,
  mapSessionSummaryHit,
  mapStrikeSummary,
  mapWhatsAppOutboundJob,
  mapWhatsAppSafetyState,
  type DailyGroupActivityRow,
  type FeedbackRow,
  type MemoryRow,
  type MessageRow,
  type ProfileRow,
  type SessionSummaryRow,
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
  BackupIntegrityStatus,
  DailyGroupActivity,
  DbMessage,
  FeedbackEntry,
  MaintenanceStats,
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

const MAX_MESSAGES_PER_CHAT = 5000;
const MESSAGE_RETENTION_DAYS = 30;
const CONTEXT_VECTOR_DIMENSIONS = 256;
const CONTEXT_RELEVANT_LIMIT = 6;
const CONTEXT_MIN_EMBED_CHARS = 8;
const SESSION_FETCH_LIMIT = 160;

const REQUIRED_CORE_TABLES = [
  'member_profiles',
  'messages',
  'conversation_sessions',
  'moderation_log',
  'daily_stats',
  'feedback',
  'memory',
  'whatsapp_outbound_jobs',
  'whatsapp_safety_state',
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

interface ExistsRow {
  exists: boolean;
}

function shouldVectorizeText(text: string): boolean {
  return text.trim().length >= CONTEXT_MIN_EMBED_CHARS;
}

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
    resolve(PROJECT_ROOT, 'src', 'utils', 'postgres-schema.sql'),
    resolve(PROJECT_ROOT, 'dist', 'utils', 'postgres-schema.sql'),
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

  let pgvectorEnabled = false;
  try {
    const extensionCheck = await pool.query<ExistsRow>(
      "SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS exists",
    );

    if (extensionCheck.rows[0]?.exists) {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await pool.query(
        `CREATE TABLE IF NOT EXISTS message_vectors (
          id BIGSERIAL PRIMARY KEY,
          chat_jid TEXT NOT NULL,
          sender TEXT NOT NULL,
          text TEXT NOT NULL,
          timestamp BIGINT NOT NULL,
          embedding vector(${CONTEXT_VECTOR_DIMENSIONS}) NOT NULL
        )`,
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS conversation_session_vectors (
          session_id BIGINT PRIMARY KEY REFERENCES conversation_sessions(id) ON DELETE CASCADE,
          chat_jid TEXT NOT NULL,
          embedding vector(${CONTEXT_VECTOR_DIMENSIONS}) NOT NULL
        )`,
      );
      await pool.query(
        'CREATE INDEX IF NOT EXISTS idx_message_vectors_chat_ts ON message_vectors (chat_jid, timestamp DESC)',
      );
      await pool.query(
        'CREATE INDEX IF NOT EXISTS idx_session_vectors_chat ON conversation_session_vectors (chat_jid)',
      );

      try {
        await pool.query(
          'CREATE INDEX IF NOT EXISTS idx_message_vectors_hnsw_cos ON message_vectors USING hnsw (embedding vector_cosine_ops)',
        );
        await pool.query(
          'CREATE INDEX IF NOT EXISTS idx_session_vectors_hnsw_cos ON conversation_session_vectors USING hnsw (embedding vector_cosine_ops)',
        );
      } catch (err) {
        logger.warn({ err }, 'pgvector HNSW index unavailable; continuing without ANN index');
      }

      pgvectorEnabled = true;
      logger.info({ dims: CONTEXT_VECTOR_DIMENSIONS }, 'pgvector context retrieval enabled');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize pgvector; using keyword context fallback');
  }

  await pool.query('SELECT 1');
  logger.info({ pgvectorEnabled, postgresSsl: config.POSTGRES_SSL }, 'Postgres backend initialized');

  const finalizeSessionSummary = async (
    client: PoolClient,
    chatJid: string,
    session: OpenSessionRow,
  ): Promise<void> => {
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
      return;
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
      return;
    }

    const participants = parseJsonArray(session.participants);
    const summary = summarizeSession(messagesRes.rows.map(mapDbMessage), participants);

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

    if (pgvectorEnabled && shouldVectorizeText(summary.summaryText)) {
      const embeddingInput = buildContextualizedEmbeddingInput(summary.summaryText, {
        chatJid,
        startedAt,
        endedAt,
        participants,
        topicTags: summary.topicTags,
      });
      const embeddingResult = await embedTextForVectorSearch(embeddingInput, CONTEXT_VECTOR_DIMENSIONS);
      const vectorLiteral = toPgvectorLiteral(embeddingResult.vector);
      await client.query(
        `INSERT INTO conversation_session_vectors (session_id, chat_jid, embedding)
         VALUES ($1, $2, $3::vector)
         ON CONFLICT (session_id)
         DO UPDATE SET chat_jid = EXCLUDED.chat_jid, embedding = EXCLUDED.embedding`,
        [sessionId, chatJid, vectorLiteral],
      );
      recordSessionEmbedding(
        chatJid,
        embeddingResult.provider,
        embeddingResult.latencyMs,
        embeddingResult.usedFallback,
      );
    }

    recordSessionSummaryLifecycle(chatJid, 'created');
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

      await finalizeSessionSummary(client, chatJid, openSession);

      await client.query(
        `INSERT INTO conversation_sessions
         (chat_jid, started_at, ended_at, message_count, participants, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'open')`,
        [chatJid, timestamp, timestamp, 1, JSON.stringify([sender])],
      );

      await client.query('COMMIT');
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

    if (pgvectorEnabled) {
      await pool.query('DELETE FROM message_vectors WHERE timestamp < $1', [cutoff]);
    }

    const afterRes = await pool.query<DbCountRow>('SELECT COUNT(*)::bigint as count FROM messages');
    const afterCount = toNumber(afterRes.rows[0]?.count);

    logger.info({
      pruned,
      beforeCount,
      afterCount,
      retentionDays: MESSAGE_RETENTION_DAYS,
      dialect: 'postgres',
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

    async storeMessage(chatJid: string, sender: string, text: string): Promise<void> {
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

      if (pgvectorEnabled && shouldVectorizeText(truncated)) {
        const embedding = embedTextDeterministic(truncated, CONTEXT_VECTOR_DIMENSIONS);
        const vectorLiteral = toPgvectorLiteral(embedding);

        await pool.query(
          `INSERT INTO message_vectors (chat_jid, sender, text, timestamp, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [chatJid, bare, truncated, ts, vectorLiteral],
        );

        await pool.query(
          `DELETE FROM message_vectors
           WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY timestamp DESC, id DESC) AS row_num
               FROM message_vectors
               WHERE chat_jid = $1
             ) ranked
             WHERE ranked.row_num > $2
           )`,
          [chatJid, MAX_MESSAGES_PER_CHAT],
        );
      }

      await upsertConversationSession(chatJid, bare, ts);
    },

    async getMessages(chatJid: string, limit: number = 15): Promise<DbMessage[]> {
      const res = await pool.query<MessageRow>(
        'SELECT sender, text, timestamp FROM messages WHERE chat_jid = $1 ORDER BY timestamp DESC, id DESC LIMIT $2',
        [chatJid, limit],
      );
      return res.rows.map(mapDbMessage).reverse();
    },

    async searchRelevantMessages(chatJid: string, query: string, limit: number = CONTEXT_RELEVANT_LIMIT): Promise<DbMessage[]> {
      const trimmed = query.trim();
      if (!trimmed) return [];

      if (pgvectorEnabled) {
        const embedding = embedTextDeterministic(trimmed, CONTEXT_VECTOR_DIMENSIONS);
        const vectorLiteral = toPgvectorLiteral(embedding);

        const vectorResults = await pool.query<MessageRow>(
          `SELECT sender, text, timestamp
           FROM message_vectors
           WHERE chat_jid = $1
           ORDER BY embedding <=> $2::vector, timestamp DESC
           LIMIT $3`,
          [chatJid, vectorLiteral, limit],
        );

        return vectorResults.rows.map(mapDbMessage);
      }

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

      if (pgvectorEnabled) {
        const queryEmbeddingInput = buildContextualizedEmbeddingInput(trimmed, { chatJid });
        const embeddingResult = await embedTextForVectorSearch(queryEmbeddingInput, CONTEXT_VECTOR_DIMENSIONS);
        const vectorLiteral = toPgvectorLiteral(embeddingResult.vector);

        const res = await pool.query<SessionSummaryRow>(
          `SELECT s.id, s.started_at, s.ended_at, s.message_count, s.participants, s.summary_text, s.topic_tags
           FROM conversation_session_vectors v
           JOIN conversation_sessions s ON s.id = v.session_id
           WHERE s.chat_jid = $1 AND s.status = 'summarized' AND s.summary_text IS NOT NULL
           ORDER BY v.embedding <=> $2::vector, s.ended_at DESC
           LIMIT $3`,
          [chatJid, vectorLiteral, limit],
        );

        return res.rows.map((row) => {
          const topicTags = parseJsonArray(row.topic_tags);
          const summaryText = row.summary_text;
          return mapSessionSummaryHit(row, scoreSessionMatch(summaryText, topicTags, trimmed, toNumber(row.ended_at)));
        });
      }

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
    ): Promise<boolean> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query(
        `UPDATE whatsapp_outbound_jobs
         SET status = $1, reason = $2, attempts = attempts + 1, updated_at = $3, sent_at = $4
         WHERE id = $5`,
        [status, reason, ts, sentAt, id],
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

    async addMemory(fact: string, category: string = 'general', source: string = 'owner'): Promise<MemoryEntry> {
      const ts = Math.floor(Date.now() / 1000);
      const res = await pool.query<MemoryRow>(
        `INSERT INTO memory (fact, category, source, created_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [fact, category, source, ts],
      );

      return mapMemoryEntry(res.rows[0]);
    },

    async getAllMemories(): Promise<MemoryEntry[]> {
      const res = await pool.query<MemoryRow>('SELECT * FROM memory ORDER BY category, created_at DESC');
      return res.rows.map(mapMemoryEntry);
    },

    async deleteMemory(id: number): Promise<boolean> {
      const res = await pool.query('DELETE FROM memory WHERE id = $1', [id]);
      return (res.rowCount ?? 0) > 0;
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

    async closeDb(): Promise<void> {
      scheduler.stopMaintenance();
      await pool.end();
      logger.info('Postgres database pool closed');
    },
  };
}
