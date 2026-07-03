import { GROUP_IDS } from '../core/groups-config.js';
import { logger } from '../middleware/logger.js';
import * as db from './db.js';
import { buildContextualizedEmbeddingInput } from './session-summary.js';
import { indexFact, indexMessage, indexSession } from './vector-memory.js';

const MAX_BACKFILL_ROWS = 2_147_483_647;

export interface BackfillProgress {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  elapsedMs: number;
}

export interface BackfillOptions {
  /** Max records to process per batch (default 20) */
  batchSize?: number;
  /** Delay between batches in ms (default 500) */
  batchDelayMs?: number;
  /** Accepted for parity with session-backfill; Qdrant upserts keep repeated runs idempotent. */
  missingOnly?: boolean;
  /** Progress callback invoked after each batch */
  onProgress?: (progress: BackfillProgress) => void;
}

type BackfillJob = {
  kind: 'fact' | 'message' | 'session';
  run: () => Promise<'indexed' | 'skipped'>;
};

type SessionRow = {
  id: number;
  chatJid: string;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  participants: string[];
  topicTags: string[];
  summaryText: string;
};

type SessionListForChat = (chatJid: string, limit?: number) => Promise<unknown[]>;
type SessionListGlobal = (limit?: number) => Promise<unknown[]>;

function createProgress(total: number): BackfillProgress {
  return {
    total,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    elapsedMs: 0,
  };
}

function toJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function getNumberField(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function getStringField(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function normalizeSessionRow(value: unknown): SessionRow | null {
  if (!value || typeof value !== 'object') return null;

  const row = value as Record<string, unknown>;
  const id = getNumberField(row, ['id', 'sessionId', 'session_id']);
  const chatJid = getStringField(row, ['chatJid', 'chat_jid']);
  const startedAt = getNumberField(row, ['startedAt', 'started_at']) ?? 0;
  const endedAt = getNumberField(row, ['endedAt', 'ended_at']);
  const messageCount = getNumberField(row, ['messageCount', 'message_count']) ?? 0;
  const summaryText = getStringField(row, ['summaryText', 'summary_text']);

  if (id === null || chatJid === null || endedAt === null || summaryText === null) {
    return null;
  }

  return {
    id,
    chatJid,
    startedAt,
    endedAt,
    messageCount,
    participants: toJsonArray(row.participants),
    topicTags: toJsonArray(row.topicTags ?? row.topic_tags),
    summaryText,
  };
}

function getDbExport(name: string): unknown {
  const exportsRecord = db as unknown as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(exportsRecord, name)
    ? exportsRecord[name]
    : undefined;
}

function isSessionListForChat(value: unknown): value is SessionListForChat {
  return typeof value === 'function';
}

function isSessionListGlobal(value: unknown): value is SessionListGlobal {
  return typeof value === 'function';
}

async function loadSessions(chatJids: string[]): Promise<SessionRow[]> {
  const rows: unknown[] = [];
  const listAllSessionSummaries = getDbExport('listAllSessionSummaries');

  if (isSessionListGlobal(listAllSessionSummaries)) {
    rows.push(...await listAllSessionSummaries(MAX_BACKFILL_ROWS));
  } else {
    const listSessionsForVectorBackfill = getDbExport('listSessionsForVectorBackfill');
    const listSessionSummaries = getDbExport('listSessionSummaries');
    const listForChat = isSessionListForChat(listSessionsForVectorBackfill)
      ? listSessionsForVectorBackfill
      : listSessionSummaries;

    if (isSessionListForChat(listForChat)) {
      for (const chatJid of chatJids) {
        rows.push(...await listForChat(chatJid, MAX_BACKFILL_ROWS));
      }
    } else {
      for (const chatJid of chatJids) {
        const hits = await db.searchRelevantSessionSummaries(
          chatJid,
          '__vector_backfill_all__',
          MAX_BACKFILL_ROWS,
        );
        rows.push(...hits.map((hit) => ({ ...hit, chatJid })));
      }
    }
  }

  return rows
    .map(normalizeSessionRow)
    .filter((row): row is SessionRow => row !== null);
}

async function buildJobs(): Promise<BackfillJob[]> {
  const chatJids = Object.keys(GROUP_IDS);
  const jobs: BackfillJob[] = [];

  const facts = await db.getAllMemories();
  for (const entry of facts) {
    jobs.push({
      kind: 'fact',
      run: async () => {
        if (entry.fact.trim().length === 0) return 'skipped';
        await indexFact({
          refId: String(entry.id),
          text: entry.fact,
          category: entry.category,
          createdAt: entry.created_at,
        });
        return 'indexed';
      },
    });
  }

  for (const chatJid of chatJids) {
    const messages = await db.getMessages(chatJid, MAX_BACKFILL_ROWS);
    for (const row of messages) {
      jobs.push({
        kind: 'message',
        run: async () => {
          if (row.text.trim().length === 0) return 'skipped';
          await indexMessage({
            chatJid,
            refId: `${row.timestamp}:${row.sender}`,
            sender: row.sender,
            text: row.text,
            createdAt: row.timestamp,
          });
          return 'indexed';
        },
      });
    }
  }

  const sessions = await loadSessions(chatJids);
  for (const session of sessions) {
    jobs.push({
      kind: 'session',
      run: async () => {
        if (session.summaryText.trim().length < 8) return 'skipped';
        await indexSession({
          chatJid: session.chatJid,
          refId: String(session.id),
          embeddingInput: buildContextualizedEmbeddingInput(session.summaryText, {
            chatJid: session.chatJid,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            participants: session.participants,
            topicTags: session.topicTags,
          }),
          summaryText: session.summaryText,
          createdAt: session.endedAt,
          extra: {
            topics: session.topicTags,
            timeRange: [session.startedAt, session.endedAt],
            messageCount: session.messageCount,
            participants: session.participants,
          },
        });
        return 'indexed';
      },
    });
  }

  return jobs;
}

async function processJob(job: BackfillJob, progress: BackfillProgress): Promise<void> {
  try {
    const result = await job.run();
    if (result === 'skipped') {
      progress.skipped += 1;
    } else {
      progress.succeeded += 1;
    }
  } catch (err) {
    progress.failed += 1;
    logger.warn({ err, kind: job.kind }, 'Vector backfill item failed');
  }
  progress.processed += 1;
}

/**
 * Re-index existing community facts, messages, and session summaries into Qdrant.
 *
 * The operation is safe to re-run because the consumed index functions upsert
 * stable point IDs derived from persisted record identifiers.
 */
export async function backfillVectors(options: BackfillOptions = {}): Promise<BackfillProgress> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 20));
  const batchDelayMs = options.batchDelayMs ?? 500;
  const startedAt = Date.now();

  if (options.missingOnly) {
    logger.info('Vector backfill missingOnly requested; stable Qdrant upserts will refresh matching points');
  }

  const jobs = await buildJobs();
  const progress = createProgress(jobs.length);

  logger.info({ total: progress.total }, 'Starting vector memory backfill');

  for (let offset = 0; offset < jobs.length; offset += batchSize) {
    const batch = jobs.slice(offset, offset + batchSize);

    for (const job of batch) {
      await processJob(job, progress);
    }

    progress.elapsedMs = Date.now() - startedAt;
    options.onProgress?.({ ...progress });

    if (progress.processed < progress.total && batchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
    }
  }

  progress.elapsedMs = Date.now() - startedAt;

  logger.info(progress, 'Vector memory backfill complete');
  return progress;
}
