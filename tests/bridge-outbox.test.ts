process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEnvelope } from '../src/bridge/envelope.js';
import { createBridgeOutbox, getBridgeOutboxStats } from '../src/bridge/outbox.js';
import { TransportDeliveryError, type BridgeTransport } from '../src/bridge/transport.js';
import type { BridgeOutboxEntry } from '../src/utils/db-types.js';
import {
  appendBridgeBuffer,
  bridgeOutboxCounts,
  bridgeSeenInsert,
  claimDueBridgeOutbox,
  enqueueBridgeOutbox,
  bumpBridgeOutboxAttempt,
  markBridgeOutboxDead,
  markBridgeOutboxSent,
  restoreBridgeBuffer,
  takeBridgeBuffer,
} from '../src/utils/db-sqlite.js';
import { db } from '../src/utils/db-schema.js';

vi.mock('pg', () => {
  const requiredTables = [
    'member_profiles',
    'messages',
    'conversation_sessions',
    'moderation_log',
    'daily_stats',
    'feedback',
    'event_reminders',
    'memory',
    'whatsapp_outbound_jobs',
    'whatsapp_safety_state',
    'songs',
    'song_ideas',
    'song_sections',
    'rehearsals',
    'availability',
    'setlists',
    'setlist_songs',
  ];

  class Pool {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes('information_schema.tables')) {
        return { rows: requiredTables.map((tableName) => ({ table_name: tableName }) as T) };
      }
      return { rows: [] };
    }
  }

  return { Pool };
});

const BASE_TIME = 1_800_000_000_000;

type BridgeOutboxOpsLike = {
  enqueueBridgeOutbox(envelope: BridgeEnvelope): Promise<BridgeOutboxEntry>;
  claimDueBridgeOutbox(limit: number): Promise<BridgeOutboxEntry[]>;
  markBridgeOutboxSent(id: number): Promise<boolean>;
  markBridgeOutboxDead(id: number, error: string): Promise<boolean>;
  bumpBridgeOutboxAttempt(id: number, nextAt: number, error: string): Promise<boolean>;
  bridgeOutboxCounts(): Promise<{ pending: number; sent: number; dead: number }>;
};

type BridgeOutboxOptionsWithOps = Parameters<typeof createBridgeOutbox>[0] & {
  ops: BridgeOutboxOpsLike;
};

const sqliteOps: BridgeOutboxOpsLike = {
  enqueueBridgeOutbox: async (env) => enqueueBridgeOutbox(env),
  claimDueBridgeOutbox: async (limit) => claimDueBridgeOutbox(limit),
  markBridgeOutboxSent: async (id) => markBridgeOutboxSent(id),
  markBridgeOutboxDead: async (id, error) => markBridgeOutboxDead(id, error),
  bumpBridgeOutboxAttempt: async (id, nextAt, error) => bumpBridgeOutboxAttempt(id, nextAt, error),
  bridgeOutboxCounts: async () => bridgeOutboxCounts(),
};

function withOps(options: BridgeOutboxOptionsWithOps): Parameters<typeof createBridgeOutbox>[0] {
  return options;
}

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

function getOutboxRow(id: number): BridgeOutboxEntry {
  const row = db.prepare('SELECT * FROM bridge_outbox WHERE id = ?').get(id) as {
    id: number;
    envelope_json: string;
    target_instance: string;
    status: BridgeOutboxEntry['status'];
    attempts: number;
    next_attempt_at: number;
    last_error: string | null;
    created_at: number;
  };
  return {
    id: row.id,
    envelopeJson: row.envelope_json,
    targetInstance: row.target_instance,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
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
    const outbox = createBridgeOutbox(withOps({
      transport: fakeTransport(deliver),
      resolveTargetUrl: () => 'http://discord.local',
      ops: sqliteOps,
    }));

    await outbox.enqueue(envelope('success-1'));
    outbox.start();
    await runOnePump();
    await outbox.stop();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'whatsapp-main:source-chat:success-1' }), 'http://discord.local');
    expect(bridgeOutboxCounts()).toEqual({ pending: 0, sent: 1, dead: 0 });
    expect(getBridgeOutboxStats().delivered).toBeGreaterThanOrEqual(1);
  });

  it('backs off retryable failures with growing next_attempt_at values', async () => {
    const deliver = vi.fn<BridgeTransport['deliver']>(async () => {
      throw new TransportDeliveryError('temporary outage', true);
    });
    const outbox = createBridgeOutbox(withOps({
      transport: fakeTransport(deliver),
      resolveTargetUrl: () => 'http://discord.local',
      ops: sqliteOps,
    }));

    const row = await enqueueBridgeOutbox(envelope('retry-1'));
    outbox.start();
    await runOnePump();
    await outbox.stop();

    const afterFirstFailure = getOutboxRow(row.id);
    expect(afterFirstFailure.attempts).toBe(1);
    expect(afterFirstFailure.lastError).toBe('temporary outage');
    vi.setSystemTime(BASE_TIME + 10_000);

    outbox.start();
    await runOnePump();
    await outbox.stop();

    const afterSecondFailure = getOutboxRow(row.id);
    expect(afterSecondFailure.attempts).toBe(2);
    expect(afterSecondFailure.lastError).toBe('temporary outage');
    vi.setSystemTime(BASE_TIME + 24_999);
    expect(claimDueBridgeOutbox(10)).toHaveLength(0);
    vi.setSystemTime(BASE_TIME + 25_000);
    const thirdDue = await claimDueBridgeOutbox(10);
    expect(thirdDue).toHaveLength(1);
    expect(thirdDue[0]?.attempts).toBe(2);
  });

  it('dead-letters non-retryable failures immediately', async () => {
    const outbox = createBridgeOutbox(withOps({
      transport: fakeTransport(async () => {
        throw new TransportDeliveryError('bad request', false);
      }),
      resolveTargetUrl: () => 'http://discord.local',
      ops: sqliteOps,
    }));

    const row = await enqueueBridgeOutbox(envelope('bad-1'));
    outbox.start();
    await runOnePump();
    await outbox.stop();

    const deadRow = getOutboxRow(row.id);
    expect(deadRow.attempts).toBe(1);
    expect(deadRow.lastError).toBe('bad request');
    expect(bridgeOutboxCounts()).toEqual({ pending: 0, sent: 0, dead: 1 });
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

    const outbox = createBridgeOutbox(withOps({
      transport: fakeTransport(async (env) => {
        if (env.idempotencyKey.endsWith('exhausted-2')) {
          throw new TransportDeliveryError('still unavailable', true);
        }
      }),
      resolveTargetUrl: () => 'http://discord.local',
      ops: sqliteOps,
    }));

    outbox.start();
    await runOnePump();
    await outbox.stop();

    const deadRow = getOutboxRow(exhausted.id);
    expect(deadRow.attempts).toBe(8);
    expect(deadRow.lastError).toBe('still unavailable');
    const counts = await bridgeOutboxCounts();
    expect(counts.dead).toBeGreaterThanOrEqual(2);
  });

  it('keeps pending rows durable across recreated outbox instances', async () => {
    const first = createBridgeOutbox(withOps({
      transport: fakeTransport(async () => undefined),
      resolveTargetUrl: () => 'http://discord.local',
      ops: sqliteOps,
    }));
    await first.enqueue(envelope('durable-1'));
    await first.stop();

    const deliver = vi.fn<BridgeTransport['deliver']>(async () => undefined);
    const second = createBridgeOutbox(withOps({
      transport: fakeTransport(deliver),
      resolveTargetUrl: () => 'http://discord.local',
      ops: sqliteOps,
    }));

    second.start();
    await runOnePump();
    await second.stop();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(bridgeOutboxCounts()).toEqual({ pending: 0, sent: 1, dead: 0 });
  });

  it('reports pending depth', async () => {
    const outbox = createBridgeOutbox(withOps({
      transport: fakeTransport(async () => undefined),
      resolveTargetUrl: () => 'http://discord.local',
      ops: sqliteOps,
    }));

    await outbox.enqueue(envelope('depth-1'));
    await outbox.enqueue(envelope('depth-2'));

    await expect(outbox.depth()).resolves.toBe(2);
  });

  it('reserves rows atomically so consecutive claims do not double-deliver the same entries', async () => {
    await enqueueBridgeOutbox(envelope('claim-1'));
    await enqueueBridgeOutbox(envelope('claim-2'));
    await enqueueBridgeOutbox(envelope('claim-3'));

    const firstClaim = await claimDueBridgeOutbox(2);
    const secondClaim = await claimDueBridgeOutbox(2);
    const firstIds = new Set(firstClaim.map((row) => row.id));
    const secondIds = new Set(secondClaim.map((row) => row.id));

    expect(firstClaim).toHaveLength(2);
    expect(secondClaim).toHaveLength(1);
    expect([...secondIds].some((id) => firstIds.has(id))).toBe(false);
    expect(firstClaim.every((row) => String(row.status) === 'claimed')).toBe(true);
    expect(secondClaim.every((row) => String(row.status) === 'claimed')).toBe(true);
  });

  it('reclaims stale claimed rows and counts them as pending depth', async () => {
    const row = await enqueueBridgeOutbox(envelope('stale-claimed-1'));
    db.prepare('UPDATE bridge_outbox SET status = ?, next_attempt_at = ? WHERE id = ?')
      .run('claimed', BASE_TIME - 121_000, row.id);

    expect(bridgeOutboxCounts()).toEqual({ pending: 1, sent: 0, dead: 0 });
    const reclaimed = await claimDueBridgeOutbox(10);

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.id).toBe(row.id);
    expect(String(reclaimed[0]?.status)).toBe('claimed');
  });

  it('returns whether a bridge idempotency key was newly inserted', async () => {
    expect(bridgeSeenInsert('origin:chat:message-1')).toBe(true);
    expect(bridgeSeenInsert('origin:chat:message-1')).toBe(false);
  });

  it('constructs with fake db ops instead of importing the runtime db barrel', async () => {
    const rows: BridgeOutboxEntry[] = [];
    const fakeOps: BridgeOutboxOpsLike = {
      enqueueBridgeOutbox: vi.fn(async (env) => {
        const row: BridgeOutboxEntry = {
          id: rows.length + 1,
          envelopeJson: JSON.stringify(env),
          targetInstance: env.targetInstance,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: Date.now(),
          lastError: null,
          createdAt: Date.now(),
        };
        rows.push(row);
        return row;
      }),
      claimDueBridgeOutbox: vi.fn(async () => rows.splice(0, rows.length)),
      markBridgeOutboxSent: vi.fn(async () => true),
      markBridgeOutboxDead: vi.fn(async () => true),
      bumpBridgeOutboxAttempt: vi.fn(async () => true),
      bridgeOutboxCounts: vi.fn(async () => ({ pending: rows.length, sent: 0, dead: 0 })),
    };
    const deliver = vi.fn<BridgeTransport['deliver']>(async () => undefined);
    const outbox = createBridgeOutbox(withOps({
      transport: fakeTransport(deliver),
      resolveTargetUrl: () => 'http://discord.local',
      ops: fakeOps,
    }));

    await outbox.enqueue(envelope('fake-ops-1'));
    outbox.start();
    await runOnePump();
    await outbox.stop();

    expect(fakeOps.enqueueBridgeOutbox).toHaveBeenCalledTimes(1);
    expect(fakeOps.claimDueBridgeOutbox).toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(fakeOps.markBridgeOutboxSent).toHaveBeenCalledWith(1);
  });

  it('tolerates duplicate delivery after a crash because receiver-side bridge_seen dedups', async () => {
    const env = envelope('dedup-after-crash-1');
    let markSentCalls = 0;
    let seen = false;
    const row: BridgeOutboxEntry = {
      id: 1,
      envelopeJson: JSON.stringify(env),
      targetInstance: env.targetInstance,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: null,
      createdAt: Date.now(),
    };
    const fakeOps: BridgeOutboxOpsLike = {
      enqueueBridgeOutbox: vi.fn(async () => row),
      claimDueBridgeOutbox: vi.fn(async () => (row.status === 'sent' ? [] : [row])),
      markBridgeOutboxSent: vi.fn(async () => {
        markSentCalls++;
        if (markSentCalls === 1) return false;
        row.status = 'sent';
        return true;
      }),
      markBridgeOutboxDead: vi.fn(async () => true),
      bumpBridgeOutboxAttempt: vi.fn(async () => true),
      bridgeOutboxCounts: vi.fn(async () => ({ pending: row.status === 'sent' ? 0 : 1, sent: row.status === 'sent' ? 1 : 0, dead: 0 })),
    };
    const bridgeSeenInsertFake = vi.fn(async () => {
      if (seen) return false;
      seen = true;
      return true;
    });
    const deliver = vi.fn<BridgeTransport['deliver']>(async (deliveredEnvelope) => {
      await bridgeSeenInsertFake(deliveredEnvelope.idempotencyKey);
    });
    const outbox = createBridgeOutbox(withOps({
      transport: fakeTransport(deliver),
      resolveTargetUrl: () => 'http://discord.local',
      ops: fakeOps,
    }));

    outbox.start();
    await runOnePump();
    await runOnePump();
    await outbox.stop();

    expect(deliver).toHaveBeenCalledTimes(2);
    await expect(bridgeSeenInsertFake.mock.results[0]?.value).resolves.toBe(true);
    await expect(bridgeSeenInsertFake.mock.results[1]?.value).resolves.toBe(false);
    expect(fakeOps.markBridgeOutboxDead).not.toHaveBeenCalled();
    await expect(fakeOps.bridgeOutboxCounts()).resolves.toEqual({ pending: 0, sent: 1, dead: 0 });
  });

  it('throws for postgres bridge outbox counts until postgres outbox support exists', async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    vi.resetModules();
    const { createPostgresBackend } = await import('../src/utils/db-postgres.js');
    const backend = await createPostgresBackend();

    await expect(backend.bridgeOutboxCounts()).rejects.toThrow('Bridge outbox is not implemented for postgres backend yet');
  });
});

describe('bridge buffer ordering across restore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    db.exec('DELETE FROM bridge_buffer;');
  });

  afterEach(() => {
    vi.useRealTimers();
    db.exec('DELETE FROM bridge_buffer;');
  });

  it('keeps restored rows ahead of messages that arrived mid-flush', () => {
    vi.setSystemTime(1_000);
    appendBridgeBuffer('route-1', 'A');

    // Flush takes A; while its send is in flight, B arrives.
    const taken = takeBridgeBuffer('route-1');
    expect(taken.map((row) => row.envelopeJson)).toEqual(['A']);

    vi.setSystemTime(2_000);
    appendBridgeBuffer('route-1', 'B');

    // Send fails; A is restored with a NEW autoincrement id but its old
    // buffered_at. The next take must still see A first (oldest-dropped
    // truncation depends on it).
    restoreBridgeBuffer(taken);
    const next = takeBridgeBuffer('route-1');
    expect(next.map((row) => row.envelopeJson)).toEqual(['A', 'B']);
  });
});
