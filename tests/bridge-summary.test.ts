process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagingPlatform } from '../src/core/messaging-platform.js';
import type { BridgeEnvelope } from '../src/bridge/envelope.js';
import { createSummaryBuffer, type BridgeBufferOps } from '../src/bridge/summary-buffer.js';
import { getLifetimeCounters } from '../src/middleware/stats.js';
import { WhatsAppOutboundHeldError } from '../src/platforms/whatsapp/outbound-safety.js';
import type { BridgeBufferEntry } from '../src/utils/db-types.js';

vi.mock('../src/middleware/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const BASE_TIME = 1_800_000_000_000;

const BASE_ENVELOPE: BridgeEnvelope = {
  v: 1,
  routeId: 'route-1',
  origin: {
    instance: 'whatsapp-main',
    platform: 'whatsapp',
    chatId: 'source-chat',
    messageId: 'message-1',
    senderId: 'sender-1',
    senderName: 'Ana',
  },
  targetInstance: 'discord-main',
  targetChatId: 'target-chat',
  text: 'hello',
  kind: 'message',
  sentAtMs: BASE_TIME,
  idempotencyKey: 'whatsapp-main:source-chat:message-1',
};

function envelope(overrides: Partial<BridgeEnvelope> & { origin?: Partial<BridgeEnvelope['origin']> } = {}): BridgeEnvelope {
  const origin = {
    ...BASE_ENVELOPE.origin,
    ...(overrides.origin ?? {}),
  };
  return {
    ...BASE_ENVELOPE,
    ...overrides,
    origin,
    idempotencyKey: overrides.idempotencyKey
      ?? `${origin.instance}:${origin.chatId}:${origin.messageId}`,
  };
}

/** In-memory fake mirroring the real bridge_buffer ops contract (append/take/restore/depths). */
function createFakeBridgeBufferOps(): BridgeBufferOps & { rowCountAcrossAllRoutes(): number } {
  let nextId = 1;
  const store = new Map<string, BridgeBufferEntry[]>();

  return {
    async appendBridgeBuffer(routeId: string, envelopeJson: string): Promise<void> {
      const rows = store.get(routeId) ?? [];
      rows.push({ id: nextId++, routeId, envelopeJson, bufferedAt: Date.now() });
      store.set(routeId, rows);
    },
    async takeBridgeBuffer(routeId: string): Promise<BridgeBufferEntry[]> {
      const rows = store.get(routeId) ?? [];
      store.set(routeId, []);
      return rows;
    },
    async restoreBridgeBuffer(rows: BridgeBufferEntry[]): Promise<void> {
      for (const row of rows) {
        const existing = store.get(row.routeId) ?? [];
        existing.push(row);
        store.set(row.routeId, existing);
      }
    },
    async bridgeBufferDepths(): Promise<Record<string, number>> {
      const depths: Record<string, number> = {};
      for (const [routeId, rows] of store) {
        if (rows.length > 0) depths[routeId] = rows.length;
      }
      return depths;
    },
    rowCountAcrossAllRoutes(): number {
      let total = 0;
      for (const rows of store.values()) total += rows.length;
      return total;
    },
  };
}

function singleRouteTargets(routeId: string, chatId: string, platform: MessagingPlatform) {
  return {
    targetChatIdForRoute: (id: string): string | null => (id === routeId ? chatId : null),
    targetPlatformForRoute: (id: string): MessagingPlatform | null => (id === routeId ? platform : null),
  };
}

async function tick(minutes: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(minutes * 60_000);
}

describe('bridge summary buffer + flusher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('skips an overlapping tick while a flush is in flight (one send max)', async () => {
    const ops = createFakeBridgeBufferOps();
    let release: (() => void) | undefined;
    const sendText = vi.fn(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const buffer = createSummaryBuffer({
      sendText,
      ...singleRouteTargets('route-1', 'target-chat', 'discord'),
      ops,
      intervalMinutes: 15,
      maxText: 1500,
    });

    await buffer.bufferEnvelope(envelope());
    buffer.start();

    await tick(15); // first tick: flush begins, send never resolves
    expect(sendText).toHaveBeenCalledTimes(1);

    await buffer.bufferEnvelope(envelope({ origin: { messageId: 'm2' } }));
    await tick(15); // overlapping tick: the flushing guard must skip it
    expect(sendText).toHaveBeenCalledTimes(1);

    release?.(); // in-flight send completes
    await vi.advanceTimersByTimeAsync(0);
    await tick(15); // next tick proceeds normally
    expect(sendText).toHaveBeenCalledTimes(2);

    buffer.stop();
  });

  it('buffers an envelope without ever sending', async () => {
    const ops = createFakeBridgeBufferOps();
    const sendText = vi.fn(async () => undefined);
    const buffer = createSummaryBuffer({
      sendText,
      ...singleRouteTargets('route-1', 'target-chat', 'discord'),
      ops,
      intervalMinutes: 15,
      maxText: 1500,
    });

    await buffer.bufferEnvelope(envelope());

    expect(sendText).not.toHaveBeenCalled();
    await expect(buffer.depths()).resolves.toEqual({ 'route-1': 1 });
  });

  it('composes one digest send with header + attributed lines, translating *bold* -> **bold** for a discord target', async () => {
    const ops = createFakeBridgeBufferOps();
    const sendText = vi.fn(async () => undefined);
    const buffer = createSummaryBuffer({
      sendText,
      ...singleRouteTargets('route-1', 'target-chat', 'discord'),
      ops,
      intervalMinutes: 15,
      maxText: 1500,
    });

    await buffer.bufferEnvelope(envelope({
      origin: { messageId: 'm1', senderName: 'Alice' },
      text: '*bold* stuff',
    }));
    await buffer.bufferEnvelope(envelope({
      origin: { messageId: 'm2', senderName: undefined, senderId: 'bob-id' },
      text: 'plain text',
    }));

    buffer.start();
    await tick(15);

    const expected = [
      'WhatsApp — last 15 min:',
      '• Alice: **bold** stuff',
      '• bob-id: plain text',
    ].join('\n');

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('target-chat', expected);
  });

  it('includes the first envelope origin chat display name in the digest header', async () => {
    const ops = createFakeBridgeBufferOps();
    const sendText = vi.fn(async () => undefined);
    const buffer = createSummaryBuffer({
      sendText,
      ...singleRouteTargets('route-1', 'target-chat', 'discord'),
      ops,
      intervalMinutes: 15,
      maxText: 1500,
    });

    await buffer.bufferEnvelope(envelope({
      origin: { messageId: 'm1', chatName: 'Community' },
      text: 'first',
    }));
    await buffer.bufferEnvelope(envelope({
      origin: { messageId: 'm2', chatName: 'Other Name' },
      text: 'second',
    }));

    buffer.start();
    await tick(15);

    expect(sendText).toHaveBeenCalledWith(
      'target-chat',
      [
        'WhatsApp Community — last 15 min:',
        '• Ana: first',
        '• Ana: second',
      ].join('\n'),
    );
  });

  it('translates **bold** -> *bold* for a whatsapp target (reverse direction)', async () => {
    const ops = createFakeBridgeBufferOps();
    const sendText = vi.fn(async () => undefined);
    const buffer = createSummaryBuffer({
      sendText,
      ...singleRouteTargets('route-1', 'target-chat', 'whatsapp'),
      ops,
      intervalMinutes: 15,
      maxText: 1500,
    });

    await buffer.bufferEnvelope(envelope({
      origin: { messageId: 'm1', platform: 'discord', senderName: 'Carl' },
      text: '**bold** stuff',
    }));
    await buffer.bufferEnvelope(envelope({
      origin: { messageId: 'm2', platform: 'discord', senderName: 'Dee' },
      text: 'plain text',
    }));

    buffer.start();
    await tick(15);

    const expected = [
      'Discord — last 15 min:',
      '• Carl: *bold* stuff',
      '• Dee: plain text',
    ].join('\n');

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('target-chat', expected);
  });

  it('truncates by dropping the oldest lines first, with a marker, and still sends exactly once', async () => {
    const ops = createFakeBridgeBufferOps();
    const sendText = vi.fn(async () => undefined);
    const buffer = createSummaryBuffer({
      sendText,
      ...singleRouteTargets('route-1', 'target-chat', 'whatsapp'),
      ops,
      intervalMinutes: 5,
      maxText: 130,
    });

    const bodies = [
      'first message here',
      'second message here',
      'third message here',
      'fourth message here',
      'fifth message here',
    ];
    for (const [i, text] of bodies.entries()) {
      await buffer.bufferEnvelope(envelope({
        origin: { messageId: `m${i}`, senderName: `U${i + 1}` },
        text,
      }));
    }

    buffer.start();
    await tick(5);

    expect(sendText).toHaveBeenCalledTimes(1);
    const [call] = sendText.mock.calls;
    expect(call).toBeDefined();
    const [, sentText] = call ?? ['', ''];
    expect(sentText.length).toBeLessThanOrEqual(130);
    expect(sentText).toContain('… (+2 earlier messages)');
    expect(sentText).not.toContain('U1:');
    expect(sentText).not.toContain('U2:');
    expect(sentText).toContain('• U3: third message here');
    expect(sentText).toContain('• U4: fourth message here');
    expect(sentText).toContain('• U5: fifth message here');

    const expected = [
      'WhatsApp — last 5 min:',
      '… (+2 earlier messages)',
      '• U3: third message here',
      '• U4: fourth message here',
      '• U5: fifth message here',
    ].join('\n');
    expect(sentText).toBe(expected);
  });

  it('restores buffered rows with zero loss when the send is held, and retries on the next tick', async () => {
    const ops = createFakeBridgeBufferOps();
    const sendText = vi.fn<(chatId: string, text: string) => Promise<void>>()
      .mockRejectedValueOnce(new WhatsAppOutboundHeldError(1, 'daily send limit reached'))
      .mockResolvedValueOnce(undefined);
    const buffer = createSummaryBuffer({
      sendText,
      ...singleRouteTargets('route-1', 'target-chat', 'discord'),
      ops,
      intervalMinutes: 10,
      maxText: 1500,
    });

    await buffer.bufferEnvelope(envelope({ origin: { messageId: 'm1' }, text: 'one' }));
    await buffer.bufferEnvelope(envelope({ origin: { messageId: 'm2' }, text: 'two' }));

    buffer.start();
    await tick(10);

    expect(sendText).toHaveBeenCalledTimes(1);
    await expect(buffer.depths()).resolves.toEqual({ 'route-1': 2 });
    expect(getLifetimeCounters().bridgeHeldByOutboundSafetyByRoute.get('route-1')).toBeGreaterThanOrEqual(1);

    await tick(10);

    expect(sendText).toHaveBeenCalledTimes(2);
    const counters = getLifetimeCounters();
    expect(counters.bridgeSummaryFlushesByRoute.get('route-1')).toBeGreaterThanOrEqual(1);
    expect(counters.bridgeDeliveryLatencyByRoute.get('route-1')?.maxSeconds).toBeGreaterThanOrEqual(0);
    expect(sendText.mock.calls[0]).toEqual(sendText.mock.calls[1]);
    await expect(buffer.depths()).resolves.toEqual({});
  });

  it('restores buffered rows and logs an error when send fails for a non-held reason', async () => {
    const { logger } = await import('../src/middleware/logger.js');
    const ops = createFakeBridgeBufferOps();
    const sendText = vi.fn(async () => {
      throw new Error('network blip');
    });
    const buffer = createSummaryBuffer({
      sendText,
      ...singleRouteTargets('route-1', 'target-chat', 'discord'),
      ops,
      intervalMinutes: 10,
      maxText: 1500,
    });

    await buffer.bufferEnvelope(envelope({ origin: { messageId: 'm1' }, text: 'super-secret-message-body' }));

    buffer.start();
    await tick(10);

    await expect(buffer.depths()).resolves.toEqual({ 'route-1': 1 });
    expect(logger.error).toHaveBeenCalled();

    const loggedText = JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls);
    expect(loggedText).not.toContain('super-secret-message-body');
    expect(loggedText).toContain('route-1');
  });

  it('logs loudly with the current depth after 10 consecutive failures on the same route', async () => {
    const ops = createFakeBridgeBufferOps();
    const sendText = vi.fn(async () => {
      throw new Error('persistent outage');
    });
    const buffer = createSummaryBuffer({
      sendText,
      ...singleRouteTargets('route-1', 'target-chat', 'discord'),
      ops,
      intervalMinutes: 1,
      maxText: 1500,
    });

    await buffer.bufferEnvelope(envelope({ origin: { messageId: 'm1' }, text: 'one' }));

    buffer.start();
    for (let i = 0; i < 10; i++) {
      await tick(1);
    }

    const { logger } = await import('../src/middleware/logger.js');
    const loudCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, message]) => typeof message === 'string' && message.includes('failing repeatedly'),
    );
    expect(loudCalls).toHaveLength(1);
    expect(loudCalls[0]?.[0]).toMatchObject({ routeId: 'route-1', consecutiveFailures: 10, depth: 1 });
  });

  it('flushes multiple routes independently, sending exactly one digest per route per tick', async () => {
    const ops = createFakeBridgeBufferOps();
    const sendText = vi.fn(async () => undefined);
    const buffer = createSummaryBuffer({
      sendText,
      targetChatIdForRoute: (routeId: string) => (routeId === 'route-a' ? 'chat-a' : 'chat-b'),
      targetPlatformForRoute: () => 'discord',
      ops,
      intervalMinutes: 15,
      maxText: 1500,
    });

    await buffer.bufferEnvelope(envelope({ routeId: 'route-a', origin: { messageId: 'a1' }, text: 'from a' }));
    await buffer.bufferEnvelope(envelope({ routeId: 'route-b', origin: { messageId: 'b1' }, text: 'from b' }));

    buffer.start();
    await tick(15);

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledWith('chat-a', expect.stringContaining('from a'));
    expect(sendText).toHaveBeenCalledWith('chat-b', expect.stringContaining('from b'));
  });

  it('stop() prevents further flushes', async () => {
    const ops = createFakeBridgeBufferOps();
    const sendText = vi.fn(async () => undefined);
    const buffer = createSummaryBuffer({
      sendText,
      ...singleRouteTargets('route-1', 'target-chat', 'discord'),
      ops,
      intervalMinutes: 5,
      maxText: 1500,
    });

    await buffer.bufferEnvelope(envelope());
    buffer.start();
    buffer.stop();

    await tick(60);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('reports buffer depths per route', async () => {
    const ops = createFakeBridgeBufferOps();
    const buffer = createSummaryBuffer({
      sendText: vi.fn(async () => undefined),
      targetChatIdForRoute: () => 'chat',
      targetPlatformForRoute: () => 'discord',
      ops,
      intervalMinutes: 15,
      maxText: 1500,
    });

    await buffer.bufferEnvelope(envelope({ routeId: 'route-a', origin: { messageId: 'a1' } }));
    await buffer.bufferEnvelope(envelope({ routeId: 'route-a', origin: { messageId: 'a2' } }));
    await buffer.bufferEnvelope(envelope({ routeId: 'route-b', origin: { messageId: 'b1' } }));

    await expect(buffer.depths()).resolves.toEqual({ 'route-a': 2, 'route-b': 1 });
  });
});
