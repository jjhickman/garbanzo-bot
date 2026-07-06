import amqplib, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { parseBridgeEnvelope, type BridgeEnvelope } from './envelope.js';
import { TransportDeliveryError, type BridgeTransport, type InboundBridgeResult } from './transport.js';

const EXCHANGE = 'garbanzo.bridge';
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const PREFETCH = 5;

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
 * case it is dropped loudly rather than looping forever). Connection loss
 * triggers a doubling backoff reconnect (5s -> 10s -> ... capped at 60s).
 */
export function createAmqpBridgeTransport({ instanceId, brokerUrl }: AmqpTransportOptions): BridgeTransport {
  const url = brokerUrl ?? config.BRIDGE_BROKER_URL;

  let connection: ChannelModel | null = null;
  let channel: ConfirmChannel | null = null;
  let consumerTag: string | null = null;
  let inboundHandler: InboundHandler | null = null;
  let connectPromise: Promise<ConfirmChannel> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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

    const conn = await amqplib.connect(url);
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

    try {
      await handler(envelope);
      ch.ack(msg);
    } catch (err) {
      if (msg.fields.redelivered) {
        logger.error(
          { err, routeId: envelope.routeId, idempotencyKey: envelope.idempotencyKey },
          'Bridge AMQP: delivery failed again after redelivery — dropping message',
        );
        ch.nack(msg, false, false);
      } else {
        logger.warn(
          { err, routeId: envelope.routeId, idempotencyKey: envelope.idempotencyKey },
          'Bridge AMQP: delivery failed — requeueing for one retry',
        );
        ch.nack(msg, false, true);
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
