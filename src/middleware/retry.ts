/**
 * Dead letter retry — messages that fail AI processing get queued
 * and retried once after a 30-second delay.
 *
 * Uses an in-memory queue (not SQLite) since retries are ephemeral
 * and shouldn't survive restarts — if the bot restarted, the messages
 * are stale anyway.
 */

import { logger } from './logger.js';

const RETRY_DELAY_MS = 30_000; // 30 seconds
const MAX_QUEUE_SIZE = 50; // prevent unbounded growth

export interface RetryEntry {
  groupJid: string;
  senderJid: string;
  query: string;
  /** Original message key for quoting the reply */
  quotedMsgId?: string;
  timestamp: number;
}

type RetryHandler = (entry: RetryEntry) => Promise<void>;

const queue: RetryEntry[] = [];
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
let handler: RetryHandler | null = null;

/** Register the retry handler — call once at startup */
export function setRetryHandler(fn: RetryHandler): void {
  handler = fn;
}

/**
 * Queue a failed message for retry.
 * Returns true if queued, false if queue is full or handler not set.
 */
export function queueRetry(entry: RetryEntry): boolean {
  if (!handler) {
    logger.warn('Retry handler not registered — dropping failed message');
    return false;
  }

  if (queue.length >= MAX_QUEUE_SIZE) {
    logger.warn({ queueSize: queue.length }, 'Retry queue full — dropping oldest entry');
    const dropped = queue.shift();
    if (dropped) {
      const key = retryKey(dropped);
      const timer = pendingTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        pendingTimers.delete(key);
      }
    }
  }

  const key = retryKey(entry);

  // Don't queue duplicates
  if (pendingTimers.has(key)) {
    logger.debug({ key }, 'Retry already pending for this message');
    return false;
  }

  queue.push(entry);

  const timer = setTimeout(async () => {
    pendingTimers.delete(key);
    const idx = queue.findIndex((e) => retryKey(e) === key);
    if (idx >= 0) queue.splice(idx, 1);

    logger.info({ groupJid: entry.groupJid, sender: entry.senderJid, query: entry.query.slice(0, 80) }, 'Retrying failed message');

    try {
      if (!handler) {
        logger.warn({ groupJid: entry.groupJid }, 'Retry handler missing at execution time — message dropped');
        return;
      }
      await handler(entry);
    } catch (err) {
      logger.error({ err, groupJid: entry.groupJid }, 'Retry also failed — message dropped');
    }
  }, RETRY_DELAY_MS);

  pendingTimers.set(key, timer);
  logger.info({ groupJid: entry.groupJid, retryIn: `${RETRY_DELAY_MS / 1000}s`, queueSize: queue.length }, 'Message queued for retry');

  return true;
}

/** Get current queue size (for health/diagnostics) */
export function getRetryQueueSize(): number {
  return queue.length;
}

/** Clear all pending retries (for graceful shutdown) */
export function clearRetryQueue(): void {
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
  queue.length = 0;
}

function retryKey(entry: RetryEntry): string {
  return `${entry.groupJid}:${entry.senderJid}:${entry.timestamp}`;
}
