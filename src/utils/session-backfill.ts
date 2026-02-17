/**
 * Session embedding backfill — re-embeds existing summarized sessions.
 *
 * Use this when switching from deterministic to OpenAI embeddings (or when
 * upgrading the embedding model) to bring existing session vectors up to
 * the current provider quality level.
 *
 * Designed to run as a one-shot task, either from a CLI script or triggered
 * via an owner command. Processes sessions in batches to avoid overwhelming
 * the embedding API with burst traffic.
 */

import { Pool, type PoolConfig } from 'pg';

import { logger } from '../middleware/logger.js';
import { config } from './config.js';
import { embedTextForVectorSearch } from './embedding-provider.js';
import { toPgvectorLiteral } from './text-embedding.js';
import { buildContextualizedEmbeddingInput } from './session-summary.js';

const CONTEXT_VECTOR_DIMENSIONS = 256;

interface BackfillableSession {
  id: number;
  chat_jid: string;
  started_at: number;
  ended_at: number;
  participants: string[];
  summary_text: string;
  topic_tags: string[];
}

export interface BackfillProgress {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  elapsedMs: number;
}

export interface BackfillOptions {
  /** Max sessions to process per batch (default 20) */
  batchSize?: number;
  /** Delay between batches in ms (default 500) */
  batchDelayMs?: number;
  /** Max total sessions to process (default unlimited) */
  maxSessions?: number;
  /** Only re-embed sessions missing from conversation_session_vectors */
  missingOnly?: boolean;
  /** Progress callback invoked after each batch */
  onProgress?: (progress: BackfillProgress) => void;
}

function resolveConnectionString(): string {
  if (config.DATABASE_URL) return config.DATABASE_URL;

  if (!config.POSTGRES_HOST || !config.POSTGRES_DB || !config.POSTGRES_USER || !config.POSTGRES_PASSWORD) {
    throw new Error('Backfill requires DATABASE_URL or POSTGRES_HOST/DB/USER/PASSWORD');
  }

  const encodedUser = encodeURIComponent(config.POSTGRES_USER);
  const encodedPass = encodeURIComponent(config.POSTGRES_PASSWORD);
  return `postgres://${encodedUser}:${encodedPass}@${config.POSTGRES_HOST}:${config.POSTGRES_PORT}/${config.POSTGRES_DB}`;
}

function toJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Run a one-shot backfill of session embeddings.
 *
 * Connects to Postgres, finds summarized sessions that need embedding,
 * generates contextualized embeddings via the current provider, and
 * upserts them into `conversation_session_vectors`.
 *
 * Returns final progress stats.
 */
export async function backfillSessionEmbeddings(
  options: BackfillOptions = {},
): Promise<BackfillProgress> {
  const batchSize = options.batchSize ?? 20;
  const batchDelayMs = options.batchDelayMs ?? 500;
  const maxSessions = options.maxSessions ?? Number.MAX_SAFE_INTEGER;
  const missingOnly = options.missingOnly ?? false;

  if (config.DB_DIALECT !== 'postgres') {
    logger.warn('Session embedding backfill is only supported on postgres (pgvector required)');
    return { total: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, elapsedMs: 0 };
  }

  const poolConfig: PoolConfig = { connectionString: resolveConnectionString() };
  if (config.POSTGRES_SSL) {
    poolConfig.ssl = { rejectUnauthorized: config.POSTGRES_SSL_REJECT_UNAUTHORIZED };
  }

  const pool = new Pool(poolConfig);
  const startedAt = Date.now();

  const progress: BackfillProgress = {
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    elapsedMs: 0,
  };

  try {
    // Verify pgvector is available
    const extCheck = await pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists",
    );
    if (!extCheck.rows[0]?.exists) {
      logger.warn('pgvector extension not enabled; backfill requires pgvector');
      return progress;
    }

    // Count eligible sessions
    const countQuery = missingOnly
      ? `SELECT COUNT(*)::int AS count FROM conversation_sessions cs
         WHERE cs.status = 'summarized' AND cs.summary_text IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM conversation_session_vectors csv WHERE csv.session_id = cs.id)`
      : `SELECT COUNT(*)::int AS count FROM conversation_sessions
         WHERE status = 'summarized' AND summary_text IS NOT NULL`;

    const countRes = await pool.query<{ count: number }>(countQuery);
    progress.total = Math.min(countRes.rows[0]?.count ?? 0, maxSessions);

    if (progress.total === 0) {
      logger.info('No sessions need embedding backfill');
      return progress;
    }

    logger.info(
      { total: progress.total, provider: config.VECTOR_EMBEDDING_PROVIDER, missingOnly },
      'Starting session embedding backfill',
    );

    let offset = 0;
    while (progress.processed < progress.total) {
      const batchQuery = missingOnly
        ? `SELECT cs.id, cs.chat_jid, cs.started_at::int, cs.ended_at::int,
                  cs.participants, cs.summary_text, cs.topic_tags
           FROM conversation_sessions cs
           WHERE cs.status = 'summarized' AND cs.summary_text IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM conversation_session_vectors csv WHERE csv.session_id = cs.id)
           ORDER BY cs.ended_at DESC
           LIMIT $1 OFFSET $2`
        : `SELECT id, chat_jid, started_at::int, ended_at::int,
                  participants, summary_text, topic_tags
           FROM conversation_sessions
           WHERE status = 'summarized' AND summary_text IS NOT NULL
           ORDER BY ended_at DESC
           LIMIT $1 OFFSET $2`;

      const batchRes = await pool.query<{
        id: number;
        chat_jid: string;
        started_at: number;
        ended_at: number;
        participants: unknown;
        summary_text: string;
        topic_tags: unknown;
      }>(batchQuery, [batchSize, offset]);

      if (batchRes.rows.length === 0) break;

      for (const row of batchRes.rows) {
        if (progress.processed >= progress.total) break;

        const session: BackfillableSession = {
          id: row.id,
          chat_jid: row.chat_jid,
          started_at: row.started_at,
          ended_at: row.ended_at,
          participants: toJsonArray(row.participants),
          summary_text: row.summary_text,
          topic_tags: toJsonArray(row.topic_tags),
        };

        try {
          if (session.summary_text.trim().length < 8) {
            progress.skipped += 1;
            progress.processed += 1;
            continue;
          }

          const embeddingInput = buildContextualizedEmbeddingInput(session.summary_text, {
            chatJid: session.chat_jid,
            startedAt: session.started_at,
            endedAt: session.ended_at,
            participants: session.participants,
            topicTags: session.topic_tags,
          });

          const result = await embedTextForVectorSearch(embeddingInput, CONTEXT_VECTOR_DIMENSIONS);
          const vectorLiteral = toPgvectorLiteral(result.vector);

          await pool.query(
            `INSERT INTO conversation_session_vectors (session_id, chat_jid, embedding)
             VALUES ($1, $2, $3::vector)
             ON CONFLICT (session_id)
             DO UPDATE SET chat_jid = EXCLUDED.chat_jid, embedding = EXCLUDED.embedding`,
            [session.id, session.chat_jid, vectorLiteral],
          );

          progress.succeeded += 1;
        } catch (err) {
          progress.failed += 1;
          logger.warn({ err, sessionId: session.id }, 'Failed to backfill session embedding');
        }

        progress.processed += 1;
      }

      offset += batchSize;
      progress.elapsedMs = Date.now() - startedAt;

      if (options.onProgress) {
        options.onProgress({ ...progress });
      }

      // Rate-limit between batches to avoid API throttling
      if (progress.processed < progress.total && batchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
      }
    }

    progress.elapsedMs = Date.now() - startedAt;

    logger.info(
      {
        ...progress,
        provider: config.VECTOR_EMBEDDING_PROVIDER,
        model: config.VECTOR_EMBEDDING_MODEL,
      },
      'Session embedding backfill complete',
    );

    return progress;
  } finally {
    await pool.end();
  }
}
