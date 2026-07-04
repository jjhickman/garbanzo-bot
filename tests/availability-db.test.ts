process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { describe, expect, it } from 'vitest';

/**
 * Band practice — availability table CRUD (sqlite backend, real db via the
 * shared `src/utils/db.js` barrel, mirroring tests/rehearsals-db.test.ts).
 */

describe('Availability — shared band practice memory', async () => {
  const { addRehearsal, setAvailability, listAvailability } = await import('../src/utils/db.js');

  it('sets availability for a rehearsal and reads it back', async () => {
    const rehearsal = await addRehearsal({ scheduledAt: 2_500_000_000 });

    const row = await setAvailability(rehearsal.id, 'member-1', 'Alice', 'yes');

    expect(row.id).toBeGreaterThan(0);
    expect(row.rehearsalId).toBe(rehearsal.id);
    expect(row.memberId).toBe('member-1');
    expect(row.memberName).toBe('Alice');
    expect(row.response).toBe('yes');
    expect(row.respondedAt).toBeGreaterThan(0);

    const list = await listAvailability(rehearsal.id);
    expect(list).toEqual([row]);
  });

  it('upserts on re-vote by the same member instead of duplicating', async () => {
    const rehearsal = await addRehearsal({ scheduledAt: 2_550_000_000 });

    const first = await setAvailability(rehearsal.id, 'member-2', 'Bob', 'no');
    const second = await setAvailability(rehearsal.id, 'member-2', 'Bob', 'yes');

    const list = await listAvailability(rehearsal.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(first.id);
    expect(list[0].id).toBe(second.id);
    expect(list[0].response).toBe('yes');
  });

  it('updates the stored member name on re-vote', async () => {
    const rehearsal = await addRehearsal({ scheduledAt: 2_575_000_000 });

    await setAvailability(rehearsal.id, 'member-2b', 'Bobby', 'maybe');
    const updated = await setAvailability(rehearsal.id, 'member-2b', 'Robert', 'yes');

    expect(updated.memberName).toBe('Robert');
    const list = await listAvailability(rehearsal.id);
    expect(list).toHaveLength(1);
    expect(list[0].memberName).toBe('Robert');
  });

  it('allows memberName to be null (unknown display name)', async () => {
    const rehearsal = await addRehearsal({ scheduledAt: 2_580_000_000 });

    const row = await setAvailability(rehearsal.id, 'member-anon', null, 'maybe');

    expect(row.memberName).toBeNull();
  });

  it('lists availability ordered by response then respondedAt', async () => {
    const rehearsal = await addRehearsal({ scheduledAt: 2_600_000_000 });

    await setAvailability(rehearsal.id, 'm-yes', 'Yes Person', 'yes');
    await setAvailability(rehearsal.id, 'm-no', 'No Person', 'no');
    await setAvailability(rehearsal.id, 'm-maybe', 'Maybe Person', 'maybe');

    const list = await listAvailability(rehearsal.id);
    expect(list.map((a) => a.response)).toEqual(['maybe', 'no', 'yes']);
  });

  it('scopes availability rows to their own rehearsal', async () => {
    const r1 = await addRehearsal({ scheduledAt: 2_650_000_000 });
    const r2 = await addRehearsal({ scheduledAt: 2_660_000_000 });

    await setAvailability(r1.id, 'member-3', 'Carol', 'yes');
    await setAvailability(r2.id, 'member-3', 'Carol', 'no');

    const list1 = await listAvailability(r1.id);
    const list2 = await listAvailability(r2.id);

    expect(list1).toHaveLength(1);
    expect(list1[0].response).toBe('yes');
    expect(list2).toHaveLength(1);
    expect(list2[0].response).toBe('no');
  });

  it('returns an empty list for a rehearsal with no responses', async () => {
    const rehearsal = await addRehearsal({ scheduledAt: 2_700_000_000 });

    expect(await listAvailability(rehearsal.id)).toEqual([]);
  });
});
