process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rehearsal } from '../src/utils/db-types.js';

const dbMocks = vi.hoisted(() => ({
  addRehearsal: vi.fn(),
  getRehearsalById: vi.fn(),
  listUpcomingRehearsals: vi.fn(),
  updateRehearsal: vi.fn(),
  cancelRehearsal: vi.fn(),
  listAvailability: vi.fn(),
}));

vi.mock('../src/utils/db.js', () => dbMocks);

import {
  formatRehearsalLine,
  handleRehearsalCommand,
  parseRehearsalWhen,
} from '../src/features/rehearsals.js';

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
    ...overrides,
  };
}

describe('parseRehearsalWhen', () => {
  it('parses YYYY-MM-DD HH:MM as unix seconds', () => {
    expect(parseRehearsalWhen('2026-07-09 19:30')).toBe(expectedSeconds(2026, 7, 9, 19, 30));
  });

  it('parses YYYY-MM-DD with a sane default evening hour', () => {
    expect(parseRehearsalWhen('2026-07-09')).toBe(expectedSeconds(2026, 7, 9, 19, 0));
  });

  it('parses small relative forms against an injected clock', () => {
    const now = new Date(2026, 6, 8, 10, 0, 0, 0);

    expect(parseRehearsalWhen('tomorrow 19:30', now)).toBe(expectedSeconds(2026, 7, 9, 19, 30));
    expect(parseRehearsalWhen('today', now)).toBe(expectedSeconds(2026, 7, 8, 19, 0));
  });

  it('returns null for invalid or unparseable dates', () => {
    expect(parseRehearsalWhen('not a date')).toBeNull();
    expect(parseRehearsalWhen('2026-02-30 19:00')).toBeNull();
    expect(parseRehearsalWhen('2026-07-09 25:00')).toBeNull();
  });
});

describe('formatRehearsalLine', () => {
  it('renders id, date, location and status', () => {
    expect(formatRehearsalLine(makeRehearsal())).toMatch(/^#3 · .+ · Studio A · scheduled$/);
  });

  it('omits location when it is null', () => {
    const result = formatRehearsalLine(makeRehearsal({ location: null }));

    expect(result).toMatch(/^#3 · .+ · scheduled$/);
    expect(result).not.toContain('Studio A');
  });
});

describe('handleRehearsalCommand', () => {
  beforeEach(() => {
    dbMocks.addRehearsal.mockReset();
    dbMocks.getRehearsalById.mockReset();
    dbMocks.listUpcomingRehearsals.mockReset();
    dbMocks.updateRehearsal.mockReset();
    dbMocks.cancelRehearsal.mockReset();
    dbMocks.listAvailability.mockReset();
    dbMocks.listAvailability.mockResolvedValue([]);
  });

  describe('schedule', () => {
    it('parses when, location and agenda fields and records the sender', async () => {
      const scheduledAt = expectedSeconds(2026, 7, 9, 19, 0);
      dbMocks.addRehearsal.mockResolvedValueOnce(makeRehearsal({ scheduledAt }));

      const result = await handleRehearsalCommand(
        'schedule when=2026-07-09 19:00 location=Studio A agenda=run the opener',
        { senderId: '222' },
      );

      expect(dbMocks.addRehearsal).toHaveBeenCalledWith({
        scheduledAt,
        location: 'Studio A',
        agenda: 'run the opener',
        createdBy: '222',
      });
      expect(result).toContain('Added');
      expect(result).toContain('#3');
      expect(result).toContain('Studio A');
    });

    it('rejects a missing date without calling addRehearsal', async () => {
      const result = await handleRehearsalCommand('schedule location=Studio A', { senderId: '222' });

      expect(dbMocks.addRehearsal).not.toHaveBeenCalled();
      expect(result).toMatch(/usage|when=/i);
    });

    it('rejects a bad date without calling addRehearsal', async () => {
      const result = await handleRehearsalCommand('schedule when=garbage location=Studio A', { senderId: '222' });

      expect(dbMocks.addRehearsal).not.toHaveBeenCalled();
      expect(result).toMatch(/date|when=/i);
    });
  });

  describe('list', () => {
    it('renders upcoming rehearsals', async () => {
      dbMocks.listUpcomingRehearsals.mockResolvedValueOnce([
        makeRehearsal({ id: 3, location: 'Studio A' }),
        makeRehearsal({ id: 4, location: null }),
      ]);

      const result = await handleRehearsalCommand('list', { senderId: '222' });

      expect(dbMocks.listUpcomingRehearsals).toHaveBeenCalledWith(expect.any(Number));
      expect(result).toContain('#3');
      expect(result).toContain('Studio A');
      expect(result).toContain('#4');
    });

    it('shows a friendly empty message', async () => {
      dbMocks.listUpcomingRehearsals.mockResolvedValueOnce([]);

      const result = await handleRehearsalCommand('list', { senderId: '222' });

      expect(result).toMatch(/no upcoming rehearsals/i);
    });
  });

  describe('show', () => {
    it('renders rehearsal details', async () => {
      dbMocks.getRehearsalById.mockResolvedValueOnce(makeRehearsal({ agenda: 'tighten transitions' }));

      const result = await handleRehearsalCommand('show 3', { senderId: '222' });

      expect(dbMocks.getRehearsalById).toHaveBeenCalledWith(3);
      expect(result).toContain('#3');
      expect(result).toContain('tighten transitions');
    });

    it('returns a not-found message', async () => {
      dbMocks.getRehearsalById.mockResolvedValueOnce(undefined);

      const result = await handleRehearsalCommand('show 999', { senderId: '222' });

      expect(result).toMatch(/not found|no rehearsal/i);
    });
  });

  describe('cancel', () => {
    it('cancels an existing rehearsal', async () => {
      dbMocks.cancelRehearsal.mockResolvedValueOnce(true);

      const result = await handleRehearsalCommand('cancel 3', { senderId: '222' });

      expect(dbMocks.cancelRehearsal).toHaveBeenCalledWith(3);
      expect(result).toMatch(/cancelled/i);
    });

    it('returns a not-found message', async () => {
      dbMocks.cancelRehearsal.mockResolvedValueOnce(false);

      const result = await handleRehearsalCommand('cancel 999', { senderId: '222' });

      expect(result).toMatch(/not found|no rehearsal/i);
    });
  });

  describe('note', () => {
    it('sets the rehearsal agenda', async () => {
      dbMocks.updateRehearsal.mockResolvedValueOnce(makeRehearsal({ agenda: 'work on harmonies' }));

      const result = await handleRehearsalCommand('note 3 work on harmonies', { senderId: '222' });

      expect(dbMocks.updateRehearsal).toHaveBeenCalledWith(3, { agenda: 'work on harmonies' });
      expect(result).toMatch(/updated/i);
      expect(result).toContain('work on harmonies');
    });

    it('returns a not-found message', async () => {
      dbMocks.updateRehearsal.mockResolvedValueOnce(undefined);

      const result = await handleRehearsalCommand('note 999 work on harmonies', { senderId: '222' });

      expect(result).toMatch(/not found|no rehearsal/i);
    });
  });

  describe('unknown/empty subcommand', () => {
    it('returns usage for an unknown subcommand', async () => {
      const result = await handleRehearsalCommand('frobnicate 3', { senderId: '222' });

      expect(result).toMatch(/usage|commands/i);
      expect(result).toMatch(/schedule/);
      expect(result).toMatch(/list/);
      expect(result).toMatch(/show/);
      expect(result).toMatch(/cancel/);
      expect(result).toMatch(/note/);
    });

    it('returns usage for empty args', async () => {
      const result = await handleRehearsalCommand('', { senderId: '222' });

      expect(result).toMatch(/usage|commands/i);
    });
  });
});
