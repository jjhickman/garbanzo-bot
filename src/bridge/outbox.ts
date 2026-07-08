import type { DbBackend } from '../utils/db-backend.js';
import { recordBridgeDeadLettered, recordBridgeFailed, recordBridgeSent } from '../middleware/stats.js';
import type { BridgeEnvelope } from './envelope.js';
import { BridgeDeliveryDeferredError, type BridgeTransport } from './transport.js';

const PUMP_INTERVAL_MS = 5_000;
const CLAIM_LIMIT = 10;
const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

export type BridgeOutboxOps = Pick<
  DbBackend,
  | 'enqueueBridgeOutbox'
  | 'claimDueBridgeOutbox'
  | 'markBridgeOutboxSent'
  | 'markBridgeOutboxDead'
  | 'bumpBridgeOutboxAttempt'
  | 'deferBridgeOutbox'
  | 'bridgeOutboxCounts'
>;

export interface BridgeOutboxOptions {
  transport: BridgeTransport;
  resolveTargetUrl(instanceId: string): string | null;
  ops: BridgeOutboxOps;
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

let envelopeModulePromise: Promise<typeof import('./envelope.js')> | null = null;
let loggerModulePromise: Promise<typeof import('../middleware/logger.js')> | null = null;

async function parseStoredEnvelope(raw: unknown): Promise<BridgeEnvelope | null> {
  envelopeModulePromise ??= import('./envelope.js');
  const { parseBridgeEnvelope } = await envelopeModulePromise;
  return parseBridgeEnvelope(raw);
}

async function logOutboxError(fields: Record<string, unknown>, message: string): Promise<void> {
  loggerModulePromise ??= import('../middleware/logger.js');
  const { logger } = await loggerModulePromise;
  logger.error(fields, message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRetryableTransportError(err: unknown): err is { retryable: boolean } {
  return typeof err === 'object'
    && err !== null
    && 'retryable' in err
    && typeof (err as { retryable: unknown }).retryable === 'boolean';
}

function nextAttemptAt(attempts: number): number {
  const backoff = Math.min((2 ** attempts) * PUMP_INTERVAL_MS, MAX_BACKOFF_MS);
  return Date.now() + backoff;
}

export function getBridgeOutboxStats(): BridgeOutboxStats {
  return { ...stats };
}

function routeLabel(envelope: BridgeEnvelope | null): string {
  return envelope?.routeId ?? 'unknown';
}

export function createBridgeOutbox(options: BridgeOutboxOptions): BridgeOutbox {
  let timer: ReturnType<typeof setInterval> | null = null;
  let pumping = false;
  let activePump: Promise<void> | null = null;

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      const rows = await options.ops.claimDueBridgeOutbox(CLAIM_LIMIT);
      for (const row of rows) {
        const rawEnvelope: unknown = JSON.parse(row.envelopeJson);
        const envelope = await parseStoredEnvelope(rawEnvelope);
        if (!envelope) {
          await options.ops.markBridgeOutboxDead(row.id, 'stored bridge envelope failed validation');
          stats.dead++;
          recordBridgeDeadLettered(routeLabel(envelope));
          await logOutboxError({ id: row.id }, 'Bridge outbox row dead-lettered: invalid envelope');
          continue;
        }

        try {
          await options.transport.deliver(envelope, options.resolveTargetUrl(row.targetInstance));
          await options.ops.markBridgeOutboxSent(row.id);
          stats.delivered++;
          recordBridgeSent(routeLabel(envelope));
        } catch (err) {
          if (err instanceof BridgeDeliveryDeferredError) {
            await options.ops.deferBridgeOutbox(row.id, err.retryAtMs, err.message);
            continue;
          }

          const message = errorMessage(err);
          const retryable = isRetryableTransportError(err) ? err.retryable : true;
          const nextAttempt = row.attempts + 1;
          recordBridgeFailed(routeLabel(envelope));

          if (!retryable || nextAttempt >= MAX_ATTEMPTS) {
            await options.ops.markBridgeOutboxDead(row.id, message);
            stats.dead++;
            recordBridgeDeadLettered(routeLabel(envelope));
            await logOutboxError({ err, id: row.id, targetInstance: row.targetInstance }, 'Bridge outbox row dead-lettered');
          } else {
            await options.ops.bumpBridgeOutboxAttempt(row.id, nextAttemptAt(row.attempts), message);
          }
        }
      }
    } catch (err) {
      await logOutboxError({ err }, 'Bridge outbox pump failed');
    } finally {
      pumping = false;
    }
  };

  const triggerPump = (): void => {
    activePump = pump().finally(() => {
      activePump = null;
    });
  };

  return {
    async enqueue(envelope: BridgeEnvelope): Promise<void> {
      await options.ops.enqueueBridgeOutbox(envelope);
    },

    start(): void {
      if (timer) return;
      timer = setInterval(triggerPump, PUMP_INTERVAL_MS);
      timer.unref?.();
    },

    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await activePump;
      await options.transport.stop();
    },

    async depth(): Promise<number> {
      return (await options.ops.bridgeOutboxCounts()).pending;
    },
  };
}
