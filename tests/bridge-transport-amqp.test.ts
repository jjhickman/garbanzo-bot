process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEnvelope } from '../src/bridge/envelope.js';
import type { InboundBridgeResult } from '../src/bridge/transport.js';

type OnHandler = (...args: unknown[]) => void;

class FakeChannel {
  asserted: { exchange?: [string, string, unknown]; queue?: [string, unknown] } = {};
  bound: [string, string, string] | undefined;
  prefetchCount: number | undefined;
  consumeHandler: ((msg: unknown) => void) | undefined;
  published: Array<{ exchange: string; routingKey: string; content: Buffer; options: unknown }> = [];
  acked: unknown[] = [];
  nacked: Array<{ msg: unknown; requeue: boolean }> = [];
  closed = false;
  confirmBehavior: 'ok' | 'error' = 'ok';
  returnOnPublish = false;
  handlers = new Map<string, OnHandler[]>();

  on(event: string, handler: OnHandler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  async assertExchange(exchange: string, type: string, options: unknown): Promise<void> {
    this.asserted.exchange = [exchange, type, options];
  }

  async assertQueue(queue: string, options: unknown): Promise<void> {
    this.asserted.queue = [queue, options];
  }

  async bindQueue(queue: string, source: string, pattern: string): Promise<void> {
    this.bound = [queue, source, pattern];
  }

  async prefetch(count: number): Promise<void> {
    this.prefetchCount = count;
  }

  async consume(_queue: string, onMessage: (msg: unknown) => void): Promise<{ consumerTag: string }> {
    this.consumeHandler = onMessage;
    return { consumerTag: 'consumer-1' };
  }

  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: { correlationId?: string } & Record<string, unknown>,
    callback?: (err: unknown, ok: unknown) => void,
  ): boolean {
    this.published.push({ exchange, routingKey, content, options });
    if (this.returnOnPublish) {
      for (const handler of this.handlers.get('return') ?? []) {
        handler({
          fields: { exchange, routingKey },
          properties: { correlationId: options.correlationId },
          content,
        });
      }
    }
    if (this.confirmBehavior === 'ok') callback?.(null, {});
    else callback?.(new Error('publish nacked'), undefined);
    return true;
  }

  ack(msg: unknown): void {
    this.acked.push(msg);
  }

  nack(msg: unknown, _allUpTo?: boolean, requeue?: boolean): void {
    this.nacked.push({ msg, requeue: requeue ?? false });
  }

  async cancel(_consumerTag: string): Promise<void> {
    // no-op for the fake
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeConnection {
  closed = false;
  handlers = new Map<string, OnHandler[]>();
  channel = new FakeChannel();

  on(event: string, handler: OnHandler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  async createConfirmChannel(): Promise<FakeChannel> {
    return this.channel;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const connectMock = vi.fn<() => Promise<FakeConnection>>();
let lastConnection: FakeConnection;

vi.mock('amqplib', () => ({
  default: {
    connect: (...args: unknown[]) => connectMock(...(args as [])),
  },
}));

function makeEnvelope(overrides: Partial<BridgeEnvelope> = {}): BridgeEnvelope {
  return {
    v: 1,
    routeId: 'route-1',
    origin: {
      instance: 'whatsapp-band',
      platform: 'whatsapp',
      chatId: 'source-chat',
      messageId: 'message-1',
      senderId: 'sender-1',
    },
    targetInstance: 'discord-band',
    targetChatId: 'target-chat',
    text: 'hello',
    kind: 'message',
    sentAtMs: 1_800_000_000_000,
    idempotencyKey: 'whatsapp-band:source-chat:message-1',
    ...overrides,
  };
}

function fakeConsumeMessage(envelope: unknown, redelivered = false): { content: Buffer; fields: { redelivered: boolean } } {
  return {
    content: Buffer.from(JSON.stringify(envelope), 'utf8'),
    fields: { redelivered },
  };
}

describe('createAmqpBridgeTransport', () => {
  beforeEach(() => {
    connectMock.mockReset();
    lastConnection = new FakeConnection();
    connectMock.mockImplementation(async () => lastConnection);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loadTransport(): Promise<typeof import('../src/bridge/transport-amqp.js')> {
    return import('../src/bridge/transport-amqp.js');
  }

  it('publishes persistent messages with routing key = targetInstance and awaits confirm', async () => {
    const { createAmqpBridgeTransport } = await loadTransport();
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });

    await transport.deliver(makeEnvelope({ targetInstance: 'whatsapp-band' }), null);

    expect(connectMock).toHaveBeenCalledWith('amqp://broker');
    expect(lastConnection.channel.asserted.exchange?.[0]).toBe('garbanzo.bridge');
    expect(lastConnection.channel.asserted.exchange?.[1]).toBe('topic');
    expect(lastConnection.channel.published).toHaveLength(1);
    const [publishCall] = lastConnection.channel.published;
    expect(publishCall?.routingKey).toBe('whatsapp-band');
    expect(publishCall?.options).toMatchObject({ persistent: true, mandatory: true });

    await transport.stop();
  });

  it('rejects delivery as retryable when RabbitMQ returns an unroutable mandatory publish', async () => {
    const { createAmqpBridgeTransport } = await loadTransport();
    const { TransportDeliveryError } = await import('../src/bridge/transport.js');
    lastConnection.channel.returnOnPublish = true;
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });

    await expect(transport.deliver(makeEnvelope({ targetInstance: 'not-yet-declared' }), null)).rejects.toMatchObject({
      name: 'TransportDeliveryError',
      retryable: true,
    });
    await expect(transport.deliver(makeEnvelope({ targetInstance: 'not-yet-declared' }), null)).rejects.toBeInstanceOf(
      TransportDeliveryError,
    );

    await transport.stop();
  });

  it('rejects delivery when the confirm callback reports an error', async () => {
    const { createAmqpBridgeTransport } = await loadTransport();
    lastConnection.channel.confirmBehavior = 'error';
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });

    await expect(transport.deliver(makeEnvelope(), null)).rejects.toThrow();

    await transport.stop();
  });

  it('asserts a per-instance durable queue, binds it, and sets prefetch 5 on startInbound', async () => {
    const { createAmqpBridgeTransport } = await loadTransport();
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });

    await transport.startInbound(async () => 'accepted');

    expect(lastConnection.channel.asserted.queue?.[0]).toBe('garbanzo.bridge.discord-band');
    expect(lastConnection.channel.asserted.queue?.[1]).toMatchObject({ durable: true });
    expect(lastConnection.channel.bound).toEqual(['garbanzo.bridge.discord-band', 'garbanzo.bridge', 'discord-band']);
    expect(lastConnection.channel.prefetchCount).toBe(5);

    await transport.stop();
  });

  it('acks on a handler result of accepted or duplicate', async () => {
    const { createAmqpBridgeTransport } = await loadTransport();
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });
    const handler = vi.fn<(env: BridgeEnvelope) => Promise<InboundBridgeResult>>(async () => 'accepted');
    await transport.startInbound(handler);

    const msg = fakeConsumeMessage(makeEnvelope());
    lastConnection.channel.consumeHandler?.(msg);
    await vi.waitFor(() => expect(lastConnection.channel.acked).toContain(msg));

    expect(lastConnection.channel.nacked).toHaveLength(0);

    await transport.stop();
  });

  it('ack + warns on a poison (invalid) message instead of looping', async () => {
    const { createAmqpBridgeTransport } = await loadTransport();
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });
    const handler = vi.fn<(env: BridgeEnvelope) => Promise<InboundBridgeResult>>(async () => 'accepted');
    await transport.startInbound(handler);

    const poison = { content: Buffer.from('not json'), fields: { redelivered: false } };
    lastConnection.channel.consumeHandler?.(poison);
    await vi.waitFor(() => expect(lastConnection.channel.acked).toContain(poison));

    expect(handler).not.toHaveBeenCalled();
    expect(lastConnection.channel.nacked).toHaveLength(0);

    await transport.stop();
  });

  it('nacks with requeue=true on the first delivery failure', async () => {
    const { createAmqpBridgeTransport } = await loadTransport();
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });
    const handler = vi.fn<(env: BridgeEnvelope) => Promise<InboundBridgeResult>>(async () => {
      throw new Error('delivery failed');
    });
    await transport.startInbound(handler);

    const msg = fakeConsumeMessage(makeEnvelope(), false);
    lastConnection.channel.consumeHandler?.(msg);
    await vi.waitFor(() => expect(lastConnection.channel.nacked).toHaveLength(1));

    expect(lastConnection.channel.nacked[0]).toMatchObject({ msg, requeue: true });
    expect(lastConnection.channel.acked).toHaveLength(0);

    await transport.stop();
  });

  it('nacks with requeue=false (drops) when a redelivered message fails again', async () => {
    const { createAmqpBridgeTransport } = await loadTransport();
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });
    const handler = vi.fn<(env: BridgeEnvelope) => Promise<InboundBridgeResult>>(async () => {
      throw new Error('delivery failed again');
    });
    await transport.startInbound(handler);

    const msg = fakeConsumeMessage(makeEnvelope(), true);
    lastConnection.channel.consumeHandler?.(msg);
    await vi.waitFor(() => expect(lastConnection.channel.nacked).toHaveLength(1));

    expect(lastConnection.channel.nacked[0]).toMatchObject({ msg, requeue: false });
    expect(lastConnection.channel.acked).toHaveLength(0);

    await transport.stop();
  });

  it('holds a deferred delivery unacked and retries after the deferral window, delivering without loss', async () => {
    vi.useFakeTimers();
    const { createAmqpBridgeTransport } = await loadTransport();
    const { BridgeDeliveryDeferredError } = await import('../src/bridge/transport.js');
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });

    let attempt = 0;
    const handler = vi.fn<(env: BridgeEnvelope) => Promise<InboundBridgeResult>>(async () => {
      attempt += 1;
      if (attempt === 1) throw new BridgeDeliveryDeferredError(Date.now() + 3_000);
      return 'accepted';
    });
    await transport.startInbound(handler);

    const msg = fakeConsumeMessage(makeEnvelope(), false);
    lastConnection.channel.consumeHandler?.(msg);

    // First attempt defers — must be held (neither acked nor nacked), not
    // dropped or requeued. advanceTimersByTimeAsync(0) flushes the pending
    // microtask chain (parse -> await handler() -> throw -> schedule) without
    // advancing the fake clock, so retryAtMs - Date.now() stays exactly 3000.
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(lastConnection.channel.acked).toHaveLength(0);
    expect(lastConnection.channel.nacked).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);

    expect(lastConnection.channel.acked).toContain(msg);
    expect(lastConnection.channel.nacked).toHaveLength(0);

    await transport.stop();
  });

  it('never drops a deferred delivery even when the message has already been redelivered once', async () => {
    vi.useFakeTimers();
    const { createAmqpBridgeTransport } = await loadTransport();
    const { BridgeDeliveryDeferredError } = await import('../src/bridge/transport.js');
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });

    let attempt = 0;
    const handler = vi.fn<(env: BridgeEnvelope) => Promise<InboundBridgeResult>>(async () => {
      attempt += 1;
      if (attempt === 1) throw new BridgeDeliveryDeferredError(Date.now() + 3_000);
      return 'accepted';
    });
    await transport.startInbound(handler);

    // redelivered = true: exactly the shape that, before this fix, fell
    // straight into the "failed again after redelivery — drop" branch on
    // the very first deferral.
    const msg = fakeConsumeMessage(makeEnvelope(), true);
    lastConnection.channel.consumeHandler?.(msg);

    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(lastConnection.channel.nacked).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(handler).toHaveBeenCalledTimes(2);

    expect(lastConnection.channel.acked).toContain(msg);
    expect(lastConnection.channel.nacked).toHaveLength(0);

    await transport.stop();
  });

  it('keeps rescheduling through multiple consecutive deferrals until delivery succeeds', async () => {
    vi.useFakeTimers();
    const { createAmqpBridgeTransport } = await loadTransport();
    const { BridgeDeliveryDeferredError } = await import('../src/bridge/transport.js');
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });

    let attempt = 0;
    const handler = vi.fn<(env: BridgeEnvelope) => Promise<InboundBridgeResult>>(async () => {
      attempt += 1;
      if (attempt < 3) throw new BridgeDeliveryDeferredError(Date.now() + 1_000);
      return 'accepted';
    });
    await transport.startInbound(handler);

    const msg = fakeConsumeMessage(makeEnvelope(), false);
    lastConnection.channel.consumeHandler?.(msg);

    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(3);

    expect(lastConnection.channel.acked).toContain(msg);
    expect(lastConnection.channel.nacked).toHaveLength(0);

    await transport.stop();
  });

  it('caps the deferred retry wait at 60s even when retryAtMs is much further out', async () => {
    vi.useFakeTimers();
    const { createAmqpBridgeTransport } = await loadTransport();
    const { BridgeDeliveryDeferredError } = await import('../src/bridge/transport.js');
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });

    let attempt = 0;
    const handler = vi.fn<(env: BridgeEnvelope) => Promise<InboundBridgeResult>>(async () => {
      attempt += 1;
      if (attempt === 1) throw new BridgeDeliveryDeferredError(Date.now() + 5 * 60_000);
      return 'accepted';
    });
    await transport.startInbound(handler);

    const msg = fakeConsumeMessage(makeEnvelope(), false);
    lastConnection.channel.consumeHandler?.(msg);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);

    await transport.stop();
  });

  it('ordinary (non-deferral) failures still follow requeue-then-drop, unaffected by the deferral path', async () => {
    vi.useFakeTimers();
    const { createAmqpBridgeTransport } = await loadTransport();
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });
    const handler = vi.fn<(env: BridgeEnvelope) => Promise<InboundBridgeResult>>(async () => {
      throw new Error('genuine failure');
    });
    await transport.startInbound(handler);

    const firstAttempt = fakeConsumeMessage(makeEnvelope(), false);
    lastConnection.channel.consumeHandler?.(firstAttempt);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastConnection.channel.nacked).toHaveLength(1);
    expect(lastConnection.channel.nacked[0]).toMatchObject({ msg: firstAttempt, requeue: true });

    const redeliveredAttempt = fakeConsumeMessage(makeEnvelope(), true);
    lastConnection.channel.consumeHandler?.(redeliveredAttempt);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastConnection.channel.nacked).toHaveLength(2);
    expect(lastConnection.channel.nacked[1]).toMatchObject({ msg: redeliveredAttempt, requeue: false });

    await transport.stop();
  });

  it('stop() cancels a pending deferred retry timer instead of leaving it to fire later', async () => {
    vi.useFakeTimers();
    const { createAmqpBridgeTransport } = await loadTransport();
    const { BridgeDeliveryDeferredError } = await import('../src/bridge/transport.js');
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });

    const handler = vi.fn<(env: BridgeEnvelope) => Promise<InboundBridgeResult>>(async () => {
      throw new BridgeDeliveryDeferredError(Date.now() + 5_000);
    });
    await transport.startInbound(handler);

    const msg = fakeConsumeMessage(makeEnvelope(), false);
    lastConnection.channel.consumeHandler?.(msg);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);

    await transport.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('schedules a reconnect with 5s->10s backoff on connection close', async () => {
    vi.useFakeTimers();
    const { createAmqpBridgeTransport } = await loadTransport();
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });

    await transport.deliver(makeEnvelope(), null);
    expect(connectMock).toHaveBeenCalledTimes(1);

    const nextConnection = new FakeConnection();
    connectMock.mockImplementation(async () => nextConnection);

    lastConnection.emit('close');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connectMock).toHaveBeenCalledTimes(2);

    // Second consecutive close doubles the backoff toward the 60s cap.
    nextConnection.emit('close');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(connectMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectMock).toHaveBeenCalledTimes(3);

    await transport.stop();
  });

  it('stop() cancels the consumer, closes the channel and connection, and clears the reconnect timer', async () => {
    vi.useFakeTimers();
    const { createAmqpBridgeTransport } = await loadTransport();
    const transport = createAmqpBridgeTransport({ instanceId: 'discord-band', brokerUrl: 'amqp://broker' });
    await transport.startInbound(async () => 'accepted');

    const cancelSpy = vi.spyOn(lastConnection.channel, 'cancel');

    await transport.stop();

    expect(cancelSpy).toHaveBeenCalledWith('consumer-1');
    expect(lastConnection.channel.closed).toBe(true);
    expect(lastConnection.closed).toBe(true);

    // A close event after stop() must not schedule a reconnect.
    lastConnection.emit('close');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});
