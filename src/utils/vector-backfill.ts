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
  /**
   * RESERVED — currently a no-op. Re-running backfill is always safe and does
   * not duplicate points (indexing derives stable point-ids from record
   * identifiers, so re-runs upsert in place), but embeddings are still
   * recomputed for every record. A true skip-if-already-present mode would
   * need an existence primitive the VectorStore does not yet expose, so this
   * flag does not currently save any work.
   */
  missingOnly?: boolean;
  /** Progress callback invoked after each batch */
  onProgress?: (progress: BackfillProgress) => void;
}

type BackfillJob = {
  kind: 'fact' | 'message' | 'session';
  run: () => Promise<'indexed' | 'skipped'>;
};

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

async function buildJobs(): Promise<BackfillJob[]> {
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

  // Enumerate every chat that has stored messages (groups AND DMs), so backfill
  // covers the same message set that live ingest indexes.
  const chatJids = await db.listMessageChatJids();
  for (const chatJid of chatJids) {
    const messages = await db.getMessages(chatJid, MAX_BACKFILL_ROWS);
    for (const row of messages) {
      jobs.push({
        kind: 'message',
        run: async () => {
          if (row.text.trim().length === 0) return 'skipped';
          await indexMessage({
            chatJid,
            // Must match live ingest's refId derivation (stored ts + bare
            // sender) so re-indexing upserts the same point rather than
            // duplicating.
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

  const sessions = await db.listSummarizedSessions(MAX_BACKFILL_ROWS);
  for (const session of sessions) {
    jobs.push({
      kind: 'session',
      run: async () => {
        if (session.summaryText.trim().length < 8) return 'skipped';
        await indexSession({
          chatJid: session.chatJid,
          refId: String(session.sessionId),
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
    logger.info('Vector backfill missingOnly is a no-op today; all records will be re-embedded and upserted');
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
