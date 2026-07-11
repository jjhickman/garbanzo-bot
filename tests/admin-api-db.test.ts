process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it } from 'vitest';

import { addAdminAuditLog, getAdminAuditLog, runMaintenance } from '../src/utils/db.js';

describe('admin audit persistence', () => {
  it('stores the required row shape and prunes rows older than 90 days', async () => {
    const recent = await addAdminAuditLog({
      ts: Date.now(),
      action: 'memory.share',
      target: '42',
      summary: 'Memory #42 shared',
      sourceIp: '127.0.0.1',
    });
    const old = await addAdminAuditLog({
      ts: Date.now() - (91 * 24 * 60 * 60 * 1000),
      action: 'memory.delete',
      target: '41',
      summary: 'Memory #41 deleted',
      sourceIp: '127.0.0.1',
    });

    await runMaintenance();
    const rows = await getAdminAuditLog(100);

    expect(rows).toContainEqual(recent);
    expect(rows.some((row) => row.id === old.id)).toBe(false);
  });
});
