import { logger } from '../middleware/logger.js';
import {
  bridgeOutboxCounts,
  bumpBridgeOutboxAttempt,
  claimDueBridgeOutbox,
  enqueueBridgeOutbox,
  markBridgeOutboxDead,
  markBridgeOutboxSent,
} from '../utils/db.js';
import { parseBridgeEnvelope, type BridgeEnvelope } from './envelope.js';
import { TransportDeliveryError, type BridgeTransport } from './transport.js';

const PUMP_INTERVAL_MS = 5_000;
const CLAIM_LIMIT = 10;
const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

export interface BridgeOutboxOptions {
  transport: BridgeTransport;
  resolveTargetUrl(instanceId: string): string | null;
}

export interface BridgeOutbox {
  enqueue(envelope: BridgeEnvelope): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  depth(): Promise<number>;
}

export interface BridgeOutboxStats {
  delivered: number;
  dead: number;
}

const stats: BridgeOutboxStats = {
  delivered: 0,
  dead: 0,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nextAttemptAt(attempts: number): number {
  const backoff = Math.min((2 ** attempts) * PUMP_INTERVAL_MS, MAX_BACKOFF_MS);
  return Date.now() + backoff;
}

export function getBridgeOutboxStats(): BridgeOutboxStats {
  return { ...stats };
}

export function createBridgeOutbox(options: BridgeOutboxOptions): BridgeOutbox {
  let timer: ReturnType<typeof setInterval> | null = null;
  let pumping = false;

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      const rows = await claimDueBridgeOutbox(CLAIM_LIMIT);
      for (const row of rows) {
        const rawEnvelope: unknown = JSON.parse(row.envelopeJson);
        const envelope = parseBridgeEnvelope(rawEnvelope);
        if (!envelope) {
          await markBridgeOutboxDead(row.id, 'stored bridge envelope failed validation');
          stats.dead++;
          logger.error({ id: row.id }, 'Bridge outbox row dead-lettered: invalid envelope');
          continue;
        }

        try {
          await options.transport.deliver(envelope, options.resolveTargetUrl(row.targetInstance));
          await markBridgeOutboxSent(row.id);
          stats.delivered++;
        } catch (err) {
          const message = errorMessage(err);
          const retryable = err instanceof TransportDeliveryError ? err.retryable : true;
          const nextAttempt = row.attempts + 1;

          if (!retryable || nextAttempt >= MAX_ATTEMPTS) {
            await markBridgeOutboxDead(row.id, message);
            stats.dead++;
            logger.error({ err, id: row.id, targetInstance: row.targetInstance }, 'Bridge outbox row dead-lettered');
          } else {
            await bumpBridgeOutboxAttempt(row.id, nextAttemptAt(row.attempts), message);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Bridge outbox pump failed');
    } finally {
      pumping = false;
    }
  };

  return {
    async enqueue(envelope: BridgeEnvelope): Promise<void> {
      await enqueueBridgeOutbox(envelope);
    },

    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        void pump();
      }, PUMP_INTERVAL_MS);
      timer.unref?.();
    },

    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await options.transport.stop();
    },

    async depth(): Promise<number> {
      return (await bridgeOutboxCounts()).pending;
    },
  };
}
