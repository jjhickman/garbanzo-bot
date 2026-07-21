process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Availability, Rehearsal } from '../src/utils/db-types.js';

const dbMocks = vi.hoisted(() => ({
  addRehearsal: vi.fn(),
  getRehearsalById: vi.fn(),
  listUpcomingRehearsals: vi.fn(),
  updateRehearsal: vi.fn(),
  cancelRehearsal: vi.fn(),
  setAvailability: vi.fn(),
  listAvailability: vi.fn(),
}));

vi.mock('../src/utils/db.js', () => dbMocks);

import { handleAvailabilityCommand, handleRehearsalCommand } from '../src/features/rehearsals.js';

function expectedSeconds(year: number, month: number, day: number, hour: number, minute: number): number {
  return Math.floor(new Date(year, month - 1, day, hour, minute, 0, 0).getTime() / 1000);
}

function makeRehearsal(overrides: Partial<Rehearsal> = {}): Rehearsal {
  return {
    id: 3,
    scheduledAt: expectedSeconds(2026, 7, 9, 19, 0),
    location: 'Studio A',
    agenda: 'run the opener',
    status: 'scheduled',
    reminderSent: false,
    createdBy: '222',
    createdAt: 0,
    updatedAt: 0,
    nativeEventId: null,
    ...overrides,
  };
}

function makeAvailability(overrides: Partial<Availability> = {}): Availability {
  return {
    id: 1,
    rehearsalId: 3,
    memberId: '222',
    memberName: 'Sam',
    response: 'yes',
    respondedAt: 0,
    ...overrides,
  };
}

const FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
const PAST_SECONDS = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

describe('handleAvailabilityCommand', () => {
  beforeEach(() => {
    dbMocks.getRehearsalById.mockReset();
    dbMocks.setAvailability.mockReset();
    dbMocks.listAvailability.mockReset();
  });

  it('rejects an unknown rehearsal id without setting availability', async () => {
    dbMocks.getRehearsalById.mockResolvedValueOnce(undefined);

    const result = await handleAvailabilityCommand('999 yes', { senderId: '222' });

    expect(dbMocks.getRehearsalById).toHaveBeenCalledWith(999);
    expect(dbMocks.setAvailability).not.toHaveBeenCalled();
    expect(result).toMatch(/not found|no rehearsal/i);
  });

  it('rejects a cancelled rehearsal without setting availability', async () => {
    dbMocks.getRehearsalById.mockResolvedValueOnce(
      makeRehearsal({ status: 'cancelled', scheduledAt: FUTURE_SECONDS }),
    );

    const result = await handleAvailabilityCommand('3 yes', { senderId: '222' });

    expect(dbMocks.setAvailability).not.toHaveBeenCalled();
    expect(result).toMatch(/cancelled/i);
  });

  it('rejects a done rehearsal without setting availability', async () => {
    dbMocks.getRehearsalById.mockResolvedValueOnce(
      makeRehearsal({ status: 'done', scheduledAt: PAST_SECONDS }),
    );

    const result = await handleAvailabilityCommand('3 yes', { senderId: '222' });

    expect(dbMocks.setAvailability).not.toHaveBeenCalled();
    expect(result).toMatch(/done/i);
  });

  it('rejects a past rehearsal without setting availability', async () => {
    dbMocks.getRehearsalById.mockResolvedValueOnce(
      makeRehearsal({ status: 'scheduled', scheduledAt: PAST_SECONDS }),
    );

    const result = await handleAvailabilityCommand('3 yes', { senderId: '222' });

    expect(dbMocks.setAvailability).not.toHaveBeenCalled();
    expect(result).toMatch(/already happened|past/i);
  });

  it('rejects an invalid response value', async () => {
    dbMocks.getRehearsalById.mockResolvedValueOnce(
      makeRehearsal({ status: 'scheduled', scheduledAt: FUTURE_SECONDS }),
    );

    const result = await handleAvailabilityCommand('3 maybenot', { senderId: '222' });

    expect(dbMocks.setAvailability).not.toHaveBeenCalled();
    expect(result).toMatch(/usage|yes.*no.*maybe/i);
  });

  it('rejects missing arguments', async () => {
    const result = await handleAvailabilityCommand('', { senderId: '222' });

    expect(dbMocks.getRehearsalById).not.toHaveBeenCalled();
    expect(result).toMatch(/usage/i);
  });

  it('accepts a valid response for a scheduled future rehearsal and records the sender', async () => {
    dbMocks.getRehearsalById.mockResolvedValueOnce(
      makeRehearsal({ status: 'scheduled', scheduledAt: FUTURE_SECONDS }),
    );
    dbMocks.setAvailability.mockResolvedValueOnce(makeAvailability({ response: 'yes' }));

    const result = await handleAvailabilityCommand('3 yes', { senderId: '222', senderName: 'Sam' });

    expect(dbMocks.setAvailability).toHaveBeenCalledWith(3, '222', 'Sam', 'yes');
    expect(result).toMatch(/yes/i);
    expect(result).toContain('#3');
  });

  it('accepts a valid response without a senderName, passing null', async () => {
    dbMocks.getRehearsalById.mockResolvedValueOnce(
      makeRehearsal({ status: 'scheduled', scheduledAt: FUTURE_SECONDS }),
    );
    dbMocks.setAvailability.mockResolvedValueOnce(makeAvailability({ response: 'no', memberName: null }));

    const result = await handleAvailabilityCommand('3 no', { senderId: '222' });

    expect(dbMocks.setAvailability).toHaveBeenCalledWith(3, '222', null, 'no');
    expect(result).toMatch(/no/i);
  });

  it('accepts "maybe" as a response', async () => {
    dbMocks.getRehearsalById.mockResolvedValueOnce(
      makeRehearsal({ status: 'scheduled', scheduledAt: FUTURE_SECONDS }),
    );
    dbMocks.setAvailability.mockResolvedValueOnce(makeAvailability({ response: 'maybe' }));

    const result = await handleAvailabilityCommand('3 MAYBE', { senderId: '222' });

    expect(dbMocks.setAvailability).toHaveBeenCalledWith(3, '222', null, 'maybe');
    expect(result).toMatch(/maybe/i);
  });
});

describe('!rehearsal show availability summary', () => {
  beforeEach(() => {
    dbMocks.getRehearsalById.mockReset();
    dbMocks.listAvailability.mockReset();
  });

  it('renders Coming/Out/Maybe groups using member names, falling back to memberId', async () => {
    dbMocks.getRehearsalById.mockResolvedValueOnce(makeRehearsal());
    dbMocks.listAvailability.mockResolvedValueOnce([
      makeAvailability({ id: 1, memberId: '111', memberName: 'Alice', response: 'yes' }),
      makeAvailability({ id: 2, memberId: '222', memberName: null, response: 'yes' }),
      makeAvailability({ id: 3, memberId: '333', memberName: 'Carol', response: 'no' }),
      makeAvailability({ id: 4, memberId: '444', memberName: 'Dave', response: 'maybe' }),
    ]);

    const result = await handleRehearsalCommand('show 3', { senderId: '222' });

    expect(result).toMatch(/Coming:.*Alice.*222/);
    expect(result).toMatch(/Out:.*Carol/);
    expect(result).toMatch(/Maybe:.*Dave/);
  });

  it('omits empty groups', async () => {
    dbMocks.getRehearsalById.mockResolvedValueOnce(makeRehearsal());
    dbMocks.listAvailability.mockResolvedValueOnce([
      makeAvailability({ id: 1, memberId: '111', memberName: 'Alice', response: 'yes' }),
    ]);

    const result = await handleRehearsalCommand('show 3', { senderId: '222' });

    expect(result).toContain('Coming: Alice');
    expect(result).not.toMatch(/Out:/);
    expect(result).not.toMatch(/Maybe:/);
  });

  it('omits the availability line entirely when there are no responses', async () => {
    dbMocks.getRehearsalById.mockResolvedValueOnce(makeRehearsal());
    dbMocks.listAvailability.mockResolvedValueOnce([]);

    const result = await handleRehearsalCommand('show 3', { senderId: '222' });

    expect(result).not.toMatch(/Coming:|Out:|Maybe:/);
  });
});
