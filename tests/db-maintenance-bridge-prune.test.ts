import { describe, it, expect } from 'vitest';

process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

const { db } = await import('../src/utils/db-schema.js');
const { runMaintenance } = await import('../src/utils/db-maintenance.js');

const DAY_MS = 24 * 60 * 60 * 1000;

function countBridgeSeen(): number {
  return (db.prepare('SELECT COUNT(*) as count FROM bridge_seen').get() as { count: number }).count;
}

function insertBridgeSeenAt(key: string, seenAtMs: number): void {
  db.prepare('INSERT OR REPLACE INTO bridge_seen (idempotency_key, seen_at) VALUES (?, ?)').run(key, seenAtMs);
}

function insertBridgeOutboxAt(
  targetInstance: string,
  status: 'pending' | 'sent' | 'dead',
  createdAtMs: number,
): void {
  db.prepare(
    `INSERT INTO bridge_outbox
     (envelope_json, target_instance, status, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run('{}', targetInstance, status, createdAtMs, createdAtMs);
}

describe('database maintenance — bridge table pruning', () => {
  it('deletes bridge_seen rows older than 30 days', () => {
    const now = Date.now();
    insertBridgeSeenAt('old-key', now - (31 * DAY_MS));
    insertBridgeSeenAt('recent-key', now - (1 * DAY_MS));

    const before = countBridgeSeen();
    runMaintenance();
    const after = countBridgeSeen();

    expect(after).toBeLessThan(before);
    const remaining = db.prepare('SELECT idempotency_key FROM bridge_seen').all() as { idempotency_key: string }[];
    expect(remaining.map((r) => r.idempotency_key)).not.toContain('old-key');
    expect(remaining.map((r) => r.idempotency_key)).toContain('recent-key');
  });

  it('deletes terminal (sent/dead) bridge_outbox rows older than 30 days but keeps recent and pending ones', () => {
    const now = Date.now();
    insertBridgeOutboxAt('old-sent-target', 'sent', now - (31 * DAY_MS));
    insertBridgeOutboxAt('old-dead-target', 'dead', now - (45 * DAY_MS));
    insertBridgeOutboxAt('recent-sent-target', 'sent', now - (1 * DAY_MS));
    insertBridgeOutboxAt('old-pending-target', 'pending', now - (90 * DAY_MS));

    runMaintenance();

    const remaining = db.prepare('SELECT target_instance, status FROM bridge_outbox').all() as
      { target_instance: string; status: string }[];
    const targets = remaining.map((r) => r.target_instance);

    expect(targets).not.toContain('old-sent-target');
    expect(targets).not.toContain('old-dead-target');
    expect(targets).toContain('recent-sent-target');
    // Old pending rows are not terminal — never pruned by this sweep.
    expect(targets).toContain('old-pending-target');
  });
});

describe('bridge outbox — terminal states strip media bytes', () => {
  const mediaEnvelope = (messageId: string) => ({
    v: 2,
    routeId: 'route-1',
    origin: {
      instance: 'a', platform: 'discord', chatId: 'chat-a',
      messageId, senderId: 'sender-1',
    },
    targetInstance: 'b',
    targetChatId: 'chat-b',
    text: '[image] keep me',
    kind: 'media-placeholder',
    sentAtMs: 1,
    idempotencyKey: `["a","chat-a","${messageId}","b","chat-b"]`,
    media: { data: 'aGVsbG8=', mimetype: 'image/png', fileName: 'x.png', kind: 'image' },
  });

  async function storedEnvelope(id: number): Promise<Record<string, unknown>> {
    const row = db.prepare('SELECT envelope_json FROM bridge_outbox WHERE id = ?').get(id) as { envelope_json: string };
    return JSON.parse(row.envelope_json) as Record<string, unknown>;
  }

  it('drops media on delivered rows so sent rows never accumulate bytes', async () => {
    const dbApi = await import('../src/utils/db.js');
    const entry = await dbApi.enqueueBridgeOutbox(mediaEnvelope('m-sent') as never);
    await dbApi.claimDueBridgeOutbox(50);
    expect(await dbApi.markBridgeOutboxSent(entry.id)).toBe(true);

    const stored = await storedEnvelope(entry.id);
    expect(stored.media).toBeUndefined();
    expect(stored.text).toBe('[image] keep me'); // text/audit fields survive
  });

  it('drops media on dead-lettered rows', async () => {
    const dbApi = await import('../src/utils/db.js');
    const entry = await dbApi.enqueueBridgeOutbox(mediaEnvelope('m-dead') as never);
    expect(await dbApi.markBridgeOutboxDead(entry.id, 'boom')).toBe(true);

    const stored = await storedEnvelope(entry.id);
    expect(stored.media).toBeUndefined();
    expect(stored.v).toBe(2);
  });
});
