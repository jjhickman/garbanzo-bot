process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';
process.env.REHEARSAL_REMINDER_LEAD_MINUTES ??= '120';

import { describe, expect, it, vi } from 'vitest';

/**
 * Band practice — rehearsals table CRUD/reminder queries (sqlite backend, real
 * db via the shared `src/utils/db.js` barrel, mirroring tests/songs-db.test.ts).
 */

describe('Rehearsals — shared band practice memory', async () => {
  const {
    addRehearsal,
    getRehearsalById,
    listUpcomingRehearsals,
    getNextRehearsal,
    updateRehearsal,
    cancelRehearsal,
    listRehearsalsNeedingReminder,
    markRehearsalReminderSent,
  } = await import('../src/utils/db.js');

  it('adds a rehearsal, then gets it by id', async () => {
    const rehearsal = await addRehearsal({
      scheduledAt: 1_800_000_000,
      location: 'The practice room',
      agenda: 'Tighten the second set',
      createdBy: 'discord-owner',
    });

    expect(rehearsal.id).toBeGreaterThan(0);
    expect(rehearsal.scheduledAt).toBe(1_800_000_000);
    expect(rehearsal.location).toBe('The practice room');
    expect(rehearsal.agenda).toBe('Tighten the second set');
    expect(rehearsal.status).toBe('scheduled');
    expect(rehearsal.reminderSent).toBe(false);
    expect(rehearsal.createdBy).toBe('discord-owner');
    expect(rehearsal.createdAt).toBeGreaterThan(0);
    expect(rehearsal.updatedAt).toBeGreaterThan(0);
    expect(await getRehearsalById(rehearsal.id)).toEqual(rehearsal);
  });

  it('returns undefined for a missing rehearsal id', async () => {
    expect(await getRehearsalById(999_999)).toBeUndefined();
  });

  it('lists upcoming rehearsals, filtering past and cancelled rows and ordering ascending', async () => {
    const now = 2_100_000_000;
    const futureLater = await addRehearsal({ scheduledAt: now + 7_200, location: 'Room B' });
    const futureSooner = await addRehearsal({ scheduledAt: now + 3_600, location: 'Room A' });
    const past = await addRehearsal({ scheduledAt: now - 60, location: 'Old room' });
    const cancelled = await addRehearsal({ scheduledAt: now + 1_800, location: 'Cancelled room' });
    await cancelRehearsal(cancelled.id);

    const upcoming = await listUpcomingRehearsals(now, 10);

    expect(upcoming.map((rehearsal) => rehearsal.id)).toEqual([futureSooner.id, futureLater.id]);
    expect(upcoming.map((rehearsal) => rehearsal.id)).not.toContain(past.id);
    expect(upcoming.map((rehearsal) => rehearsal.id)).not.toContain(cancelled.id);
  });

  it('gets the next rehearsal as the soonest future scheduled row', async () => {
    const now = 2_200_000_000;
    await addRehearsal({ scheduledAt: now + 4_800 });
    const soonest = await addRehearsal({ scheduledAt: now + 1_200 });
    await addRehearsal({ scheduledAt: now - 1_200 });
    const cancelled = await addRehearsal({ scheduledAt: now + 600 });
    await cancelRehearsal(cancelled.id);

    expect(await getNextRehearsal(now)).toEqual(soonest);
  });

  it('updates only the provided fields and bumps updatedAt', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2035-01-01T00:00:00Z'));
      const created = await addRehearsal({
        scheduledAt: 2_300_000_000,
        location: 'Original room',
        agenda: 'Original agenda',
        createdBy: 'discord-owner',
      });
      const preUpdateUpdatedAt = created.updatedAt;

      vi.advanceTimersByTime(1_500);

      const updated = await updateRehearsal(created.id, {
        scheduledAt: 2_300_003_600,
        location: null,
        status: 'done',
      });

      expect(updated).toBeDefined();
      expect(updated?.scheduledAt).toBe(2_300_003_600);
      expect(updated?.location).toBeNull();
      expect(updated?.agenda).toBe('Original agenda');
      expect(updated?.status).toBe('done');
      expect(updated?.reminderSent).toBe(false);
      expect(updated?.createdBy).toBe('discord-owner');
      expect(updated?.createdAt).toBe(created.createdAt);
      expect(updated?.updatedAt).toBeGreaterThan(preUpdateUpdatedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns undefined when updating a missing rehearsal', async () => {
    expect(await updateRehearsal(999_999, { location: 'Nowhere' })).toBeUndefined();
  });

  it('cancels a rehearsal by setting status to cancelled', async () => {
    const rehearsal = await addRehearsal({ scheduledAt: 2_350_000_000 });

    expect(await cancelRehearsal(rehearsal.id)).toBe(true);
    expect((await getRehearsalById(rehearsal.id))?.status).toBe('cancelled');
    expect(await cancelRehearsal(999_999)).toBe(false);
  });

  it('lists rehearsals needing reminders within the configured lead window', async () => {
    const now = 2_400_000_000;
    const dueAtLeadBoundary = await addRehearsal({ scheduledAt: now + 7_200 });
    const dueSoon = await addRehearsal({ scheduledAt: now + 60 });
    const tooEarly = await addRehearsal({ scheduledAt: now + 7_201 });
    const past = await addRehearsal({ scheduledAt: now - 1 });
    const cancelled = await addRehearsal({ scheduledAt: now + 600 });
    const done = await addRehearsal({ scheduledAt: now + 900 });
    const alreadySent = await addRehearsal({ scheduledAt: now + 1_200 });

    await cancelRehearsal(cancelled.id);
    await updateRehearsal(done.id, { status: 'done' });
    await markRehearsalReminderSent(alreadySent.id);

    const needingReminder = await listRehearsalsNeedingReminder(now);

    expect(needingReminder.map((rehearsal) => rehearsal.id)).toEqual([
      dueSoon.id,
      dueAtLeadBoundary.id,
    ]);
    expect(needingReminder.map((rehearsal) => rehearsal.id)).not.toContain(tooEarly.id);
    expect(needingReminder.map((rehearsal) => rehearsal.id)).not.toContain(past.id);
    expect(needingReminder.map((rehearsal) => rehearsal.id)).not.toContain(cancelled.id);
    expect(needingReminder.map((rehearsal) => rehearsal.id)).not.toContain(done.id);
    expect(needingReminder.map((rehearsal) => rehearsal.id)).not.toContain(alreadySent.id);
  });

  it('marks a rehearsal reminder as sent', async () => {
    const rehearsal = await addRehearsal({ scheduledAt: 2_450_000_000 });

    expect(await markRehearsalReminderSent(rehearsal.id)).toBe(true);
    expect((await getRehearsalById(rehearsal.id))?.reminderSent).toBe(true);
    expect(await markRehearsalReminderSent(999_999)).toBe(false);
  });
});
