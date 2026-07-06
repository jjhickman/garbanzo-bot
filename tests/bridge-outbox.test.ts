process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEnvelope } from '../src/bridge/envelope.js';
import { createBridgeOutbox, getBridgeOutboxStats } from '../src/bridge/outbox.js';
import { TransportDeliveryError, type BridgeTransport } from '../src/bridge/transport.js';
import {
  bridgeOutboxCounts,
  bridgeSeenInsert,
  claimDueBridgeOutbox,
  enqueueBridgeOutbox,
  markBridgeOutboxDead,
} from '../src/utils/db.js';
import { db } from '../src/utils/db-schema.js';

const BASE_TIME = 1_800_000_000_000;

function envelope(id: string, targetInstance = 'discord-main'): BridgeEnvelope {
  return {
    v: 1,
    routeId: 'route-1',
    origin: {
      instance: 'whatsapp-main',
      platform: 'whatsapp',
      chatId: 'source-chat',
      messageId: id,
      senderId: 'sender-1',
      senderName: 'Sender One',
    },
    targetInstance,
    targetChatId: 'target-chat',
    text: `bridge text ${id}`,
    kind: 'message',
    sentAtMs: BASE_TIME,
    idempotencyKey: `whatsapp-main:source-chat:${id}`,
  };
}

function fakeTransport(deliver: BridgeTransport['deliver']): BridgeTransport {
  return {
    deliver,
    startInbound: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

async function runOnePump(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000);
}

describe('bridge durable outbox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    db.exec('DELETE FROM bridge_outbox; DELETE FROM bridge_seen;');
  });

  afterEach(() => {
    vi.useRealTimers();
    db.exec('DELETE FROM bridge_outbox; DELETE FROM bridge_seen;');
  });

  it('delivers due rows and marks them sent', async () => {
    const deliver = vi.fn<BridgeTransport['deliver']>(async () => undefined);
    const outbox = createBridgeOutbox({
      transport: fakeTransport(deliver),
      resolveTargetUrl: () => 'http://discord.local',
    });

    await outbox.enqueue(envelope('success-1'));
    outbox.start();
    await runOnePump();
    await outbox.stop();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'whatsapp-main:source-chat:success-1' }), 'http://discord.local');
    await expect(bridgeOutboxCounts()).resolves.toEqual({ pending: 0, sent: 1, dead: 0 });
    expect(getBridgeOutboxStats().delivered).toBeGreaterThanOrEqual(1);
  });

  it('backs off retryable failures with growing next_attempt_at values', async () => {
    const deliver = vi.fn<BridgeTransport['deliver']>(async () => {
      throw new TransportDeliveryError('temporary outage', true);
    });
    const outbox = createBridgeOutbox({
      transport: fakeTransport(deliver),
      resolveTargetUrl: () => 'http://discord.local',
    });

    await outbox.enqueue(envelope('retry-1'));
    outbox.start();
    await runOnePump();
    await outbox.stop();

    const firstRows = await claimDueBridgeOutbox(10);
    expect(firstRows).toHaveLength(0);
    vi.setSystemTime(BASE_TIME + 10_000);
    const secondDue = await claimDueBridgeOutbox(10);
    expect(secondDue).toHaveLength(1);
    expect(secondDue[0]?.attempts).toBe(1);

    outbox.start();
    await runOnePump();
    await outbox.stop();

    vi.setSystemTime(BASE_TIME + 24_999);
    await expect(claimDueBridgeOutbox(10)).resolves.toHaveLength(0);
    vi.setSystemTime(BASE_TIME + 25_000);
    const thirdDue = await claimDueBridgeOutbox(10);
    expect(thirdDue).toHaveLength(1);
    expect(thirdDue[0]?.attempts).toBe(2);
  });

  it('dead-letters non-retryable failures immediately', async () => {
    const outbox = createBridgeOutbox({
      transport: fakeTransport(async () => {
        throw new TransportDeliveryError('bad request', false);
      }),
      resolveTargetUrl: () => 'http://discord.local',
    });

    await outbox.enqueue(envelope('bad-1'));
    outbox.start();
    await runOnePump();
    await outbox.stop();

    await expect(bridgeOutboxCounts()).resolves.toEqual({ pending: 0, sent: 0, dead: 1 });
    expect(getBridgeOutboxStats().dead).toBeGreaterThanOrEqual(1);
  });

  it('dead-letters retryable rows after 8 failed attempts', async () => {
    const row = await enqueueBridgeOutbox(envelope('exhausted-1'));
    await markBridgeOutboxDead(row.id, 'seed');
    for (let attempt = 0; attempt < 8; attempt++) {
      await enqueueBridgeOutbox(envelope(`filler-${attempt}`));
    }

    const exhausted = await enqueueBridgeOutbox(envelope('exhausted-2'));
    db.prepare('UPDATE bridge_outbox SET attempts = 7 WHERE id = ?').run(exhausted.id);

    const outbox = createBridgeOutbox({
      transport: fakeTransport(async (env) => {
        if (env.idempotencyKey.endsWith('exhausted-2')) {
          throw new TransportDeliveryError('still unavailable', true);
        }
      }),
      resolveTargetUrl: () => 'http://discord.local',
    });

    outbox.start();
    await runOnePump();
    await outbox.stop();

    const counts = await bridgeOutboxCounts();
    expect(counts.dead).toBeGreaterThanOrEqual(2);
  });

  it('keeps pending rows durable across recreated outbox instances', async () => {
    const first = createBridgeOutbox({
      transport: fakeTransport(async () => undefined),
      resolveTargetUrl: () => 'http://discord.local',
    });
    await first.enqueue(envelope('durable-1'));
    await first.stop();

    const deliver = vi.fn<BridgeTransport['deliver']>(async () => undefined);
    const second = createBridgeOutbox({
      transport: fakeTransport(deliver),
      resolveTargetUrl: () => 'http://discord.local',
    });

    second.start();
    await runOnePump();
    await second.stop();

    expect(deliver).toHaveBeenCalledTimes(1);
    await expect(bridgeOutboxCounts()).resolves.toEqual({ pending: 0, sent: 1, dead: 0 });
  });

  it('reports pending depth', async () => {
    const outbox = createBridgeOutbox({
      transport: fakeTransport(async () => undefined),
      resolveTargetUrl: () => 'http://discord.local',
    });

    await outbox.enqueue(envelope('depth-1'));
    await outbox.enqueue(envelope('depth-2'));

    await expect(outbox.depth()).resolves.toBe(2);
  });

  it('returns whether a bridge idempotency key was newly inserted', async () => {
    await expect(bridgeSeenInsert('origin:chat:message-1')).resolves.toBe(true);
    await expect(bridgeSeenInsert('origin:chat:message-1')).resolves.toBe(false);
  });
});
