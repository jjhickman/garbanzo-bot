import amqplib, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { parseBridgeEnvelope, type BridgeEnvelope } from './envelope.js';
import {
  BridgeDeliveryDeferredError,
  TransportDeliveryError,
  type BridgeTransport,
  type InboundBridgeResult,
} from './transport.js';

const EXCHANGE = 'garbanzo.bridge';
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const PREFETCH = 5;
// Longest we'll sleep before retrying a deferred delivery in-process. A
// BridgeDeliveryDeferredError's retryAtMs can be far in the future (pacing
// windows are seconds, but a homeserver/platform retry-after could in theory
// be minutes) — capping the setTimeout keeps a single deferred message from
// pinning this consumer for an unbounded time and re-checks readiness
// periodically instead.
const MAX_DEFER_RETRY_MS = 60_000;

export interface AmqpTransportOptions {
  instanceId: string;
  brokerUrl?: string;
}

type InboundHandler = (envelope: BridgeEnvelope) => Promise<InboundBridgeResult>;

/**
 * AMQP/RabbitMQ bridge transport (owner-directed N-instance topology).
 *
 * Topology: one topic exchange (`garbanzo.bridge`, durable), one durable
 * queue per instance bound on routing key = instance id, persistent messages,
 * publisher confirms on send, manual acks on receive. Acks ONLY on a handler
 * result of 'accepted'/'duplicate' — a thrown handler error nacks (with
 * requeue unless the message has already been redelivered once, in which
 * case it is dropped loudly rather than looping forever). A thrown
 * BridgeDeliveryDeferredError (pacing/rate-limit backpressure, not a
 * failure) is handled separately — see attemptDelivery — and never reaches
 * that redelivered-drop path. Connection loss triggers a doubling backoff
 * reconnect (5s -> 10s -> ... capped at 60s).
 */
export function createAmqpBridgeTransport({ instanceId, brokerUrl }: AmqpTransportOptions): BridgeTransport {
  const url = brokerUrl ?? config.BRIDGE_BROKER_URL;

  let connection: ChannelModel | null = null;
  let channel: ConfirmChannel | null = null;
  let consumerTag: string | null = null;
  let inboundHandler: InboundHandler | null = null;
  let connectPromise: Promise<ConfirmChannel> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // In-flight setTimeout handles from deferred deliveries (see
  // attemptDelivery) that are still waiting to retry. Tracked so stop() can
  // cancel them — the held messages themselves need no cleanup beyond that,
  // since an unacked message is returned to the queue by the broker as soon
  // as this channel/connection closes.
  const pendingDeferrals = new Set<ReturnType<typeof setTimeout>>();
  // Doubles on every scheduled reconnect attempt for this transport's
  // lifetime and is intentionally NOT reset on a successful reconnect —
  // simpler and deterministic under rapid flapping, at the cost of a
  // conservatively long delay if a connection drops again long after
  // recovering. Revisit with a stability-timer reset if that trade-off
  // bites in production.
  let backoffMs = INITIAL_BACKOFF_MS;
  let stopped = false;

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectPromise = null;
      void ensureChannel().catch((err) => {
        logger.error({ err }, 'Bridge AMQP reconnect attempt failed');
        scheduleReconnect();
      });
    }, delay);
    reconnectTimer.unref?.();
  }

  function handleConnectionLoss(reason: string, err?: unknown): void {
    channel = null;
    connection = null;
    connectPromise = null;
    if (err !== undefined) logger.error({ err }, `Bridge AMQP connection ${reason}`);
    if (!stopped) scheduleReconnect();
  }

  async function connectChannel(): Promise<ConfirmChannel> {
    if (!url) throw new Error('BRIDGE_BROKER_URL is required for the amqp bridge transport');
    if (stopped) throw new Error('bridge amqp transport is stopped');

    const conn = await amqplib.connect(url);
    if (stopped) {
      // stop() raced an in-flight reconnect — do not silently reopen.
      await conn.close().catch(() => undefined);
      throw new Error('bridge amqp transport stopped during reconnect');
    }
    conn.on('close', () => handleConnectionLoss('closed'));
    conn.on('error', (err) => handleConnectionLoss('error', err));

    const ch = await conn.createConfirmChannel();
    ch.on('error', (err) => logger.error({ err }, 'Bridge AMQP channel error'));
    await ch.assertExchange(EXCHANGE, 'topic', { durable: true });

    connection = conn;
    channel = ch;

    if (inboundHandler) await bindConsumer(ch, inboundHandler);

    return ch;
  }

  async function ensureChannel(): Promise<ConfirmChannel> {
    if (channel) return channel;
    connectPromise ??= connectChannel().finally(() => {
      connectPromise = null;
    });
    return connectPromise;
  }

  async function bindConsumer(ch: ConfirmChannel, handler: InboundHandler): Promise<void> {
    const queue = `garbanzo.bridge.${instanceId}`;
    await ch.assertQueue(queue, { durable: true });
    await ch.bindQueue(queue, EXCHANGE, instanceId);
    await ch.prefetch(PREFETCH);

    const { consumerTag: tag } = await ch.consume(queue, (msg) => {
      if (!msg) return;
      void handleDelivery(ch, msg, handler);
    });
    consumerTag = tag;
  }

  async function handleDelivery(ch: ConfirmChannel, msg: ConsumeMessage, handler: InboundHandler): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(msg.content.toString('utf8'));
    } catch (err) {
      logger.warn({ err }, 'Bridge AMQP: poison message failed JSON parse — acking and dropping');
      ch.ack(msg);
      return;
    }

    const envelope = parseBridgeEnvelope(raw);
    if (!envelope) {
      logger.warn('Bridge AMQP: poison message failed envelope validation — acking and dropping');
      ch.ack(msg);
      return;
    }

    await attemptDelivery(ch, msg, envelope, handler);
  }

  function safeSettle(action: () => void, label: string): void {
    try {
      action();
    } catch (err) {
      // The channel can close (reconnect, shutdown) between our staleness
      // check and this call — settling a dead channel is a no-op from the
      // broker's point of view (it already reclaimed the message), so log
      // and move on rather than letting this throw out of a setTimeout
      // callback or a fire-and-forget handleDelivery.
      logger.warn({ err }, `Bridge AMQP: ${label} failed — channel likely closed`);
    }
  }

  /**
   * Deliver `envelope` to `handler` and settle `msg` accordingly.
   *
   * A thrown BridgeDeliveryDeferredError is pacing/rate-limit backpressure
   * from the handler (e.g. a same-chat outbound pacing window, or a Matrix
   * M_LIMIT_EXCEEDED wait longer than the adapter's inline budget) — NOT a
   * failure — and must never reach the ordinary-failure branch below. Before
   * this fix, a deferred delivery was nacked with requeue=true, which the
   * broker redelivers almost immediately; if the pacing window was still
   * open the handler deferred again, but this second delivery now has
   * `msg.fields.redelivered === true`, so the ordinary-failure branch
   * dropped it via nack(false, false) — silently losing a message that was
   * never actually a failure. Instead: hold the message unacked (no ack, no
   * nack) and reschedule this SAME delivery attempt in-process after
   * min(retryAtMs - now, MAX_DEFER_RETRY_MS). If the retried delivery defers
   * again, keep rescheduling — this can repeat indefinitely — until it
   * either succeeds (ack) or throws a genuine, non-deferral error, at which
   * point today's redeliver-then-drop nack semantics apply unchanged.
   *
   * Head-of-line trade-off (honest accounting): this consumer runs with
   * prefetch=5 (PREFETCH above), so a held, unacked deferred message
   * occupies exactly one of those 5 slots — up to 4 other deliveries on this
   * same per-instance queue keep flowing concurrently rather than the whole
   * queue stalling behind one deferral. If PREFETCH were 1, a deferred
   * message WOULD pause this queue's consumption entirely until its
   * deadline: for a queue whose messages all address the same downstream
   * chat, that full pause is actually what pacing wants (nothing could jump
   * the line anyway); for a queue mixing multiple routes/chats behind one
   * instance, it would also delay unrelated routes that have nothing to do
   * with the paced chat. At prefetch=5 we get the second queue's throughput
   * back at the cost of the first queue's stricter serialization — a
   * deliberate, documented trade rather than an accident.
   */
  async function attemptDelivery(
    ch: ConfirmChannel,
    msg: ConsumeMessage,
    envelope: BridgeEnvelope,
    handler: InboundHandler,
  ): Promise<void> {
    try {
      await handler(envelope);
      safeSettle(() => ch.ack(msg), 'ack');
    } catch (err) {
      if (err instanceof BridgeDeliveryDeferredError) {
        if (stopped) {
          // Shutting down — leave the message unacked; the broker returns it
          // to the queue when this channel/connection closes.
          return;
        }

        const delayMs = Math.max(0, Math.min(err.retryAtMs - Date.now(), MAX_DEFER_RETRY_MS));
        logger.info(
          { routeId: envelope.routeId, idempotencyKey: envelope.idempotencyKey, delayMs },
          'Bridge AMQP: delivery deferred — holding message unacked and retrying after the deferral window',
        );

        const timer = setTimeout(() => {
          pendingDeferrals.delete(timer);
          if (stopped || channel !== ch) {
            // Transport stopped, or this channel was replaced by a
            // reconnect — the broker already (or will) redeliver the held
            // message fresh via the new consumer, so abandon this retry
            // loop rather than double-handle it.
            logger.warn(
              { routeId: envelope.routeId, idempotencyKey: envelope.idempotencyKey },
              'Bridge AMQP: abandoning deferred retry — transport stopped or channel replaced by reconnect',
            );
            return;
          }
          void attemptDelivery(ch, msg, envelope, handler);
        }, delayMs);
        timer.unref?.();
        pendingDeferrals.add(timer);
        return;
      }

      if (msg.fields.redelivered) {
        logger.error(
          { err, routeId: envelope.routeId, idempotencyKey: envelope.idempotencyKey },
          'Bridge AMQP: delivery failed again after redelivery — dropping message',
        );
        safeSettle(() => ch.nack(msg, false, false), 'nack (drop)');
      } else {
        logger.warn(
          { err, routeId: envelope.routeId, idempotencyKey: envelope.idempotencyKey },
          'Bridge AMQP: delivery failed — requeueing for one retry',
        );
        safeSettle(() => ch.nack(msg, false, true), 'nack (requeue)');
      }
    }
  }

  return {
    async deliver(envelope: BridgeEnvelope): Promise<void> {
      let ch: ConfirmChannel;
      try {
        ch = await ensureChannel();
      } catch (err) {
        throw new TransportDeliveryError('Bridge AMQP channel unavailable', true, { cause: err });
      }

      const body = Buffer.from(JSON.stringify(envelope), 'utf8');

      try {
        await new Promise<void>((resolve, reject) => {
          ch.publish(EXCHANGE, envelope.targetInstance, body, { persistent: true }, (err) => {
            if (err) reject(err instanceof Error ? err : new Error(String(err)));
            else resolve();
          });
        });
      } catch (err) {
        throw new TransportDeliveryError('Bridge AMQP publish failed', true, { cause: err });
      }
    },

    async startInbound(handler: InboundHandler): Promise<void> {
      inboundHandler = handler;
      const ch = await ensureChannel();
      if (!consumerTag) await bindConsumer(ch, handler);
    },

    async stop(): Promise<void> {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      for (const timer of pendingDeferrals) clearTimeout(timer);
      pendingDeferrals.clear();

      const ch = channel;
      const conn = connection;
      const tag = consumerTag;
      channel = null;
      connection = null;
      consumerTag = null;

      try {
        if (ch && tag) await ch.cancel(tag);
      } catch (err) {
        logger.warn({ err }, 'Bridge AMQP: consumer cancel failed during stop');
      }
      try {
        if (ch) await ch.close();
      } catch (err) {
        logger.warn({ err }, 'Bridge AMQP: channel close failed during stop');
      }
      try {
        if (conn) await conn.close();
      } catch (err) {
        logger.warn({ err }, 'Bridge AMQP: connection close failed during stop');
      }
    },
  };
}
