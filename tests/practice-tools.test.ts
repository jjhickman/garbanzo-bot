process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Availability, Rehearsal, Setlist, SetlistEntry, Song } from '../src/utils/db-types.js';

const dbMocks = vi.hoisted(() => ({
  getNextRehearsal: vi.fn(),
  listAvailability: vi.fn(),
  listSetlists: vi.fn(),
  getSetlistByName: vi.fn(),
  getSetlistSongs: vi.fn(),
}));

vi.mock('../src/utils/db.js', () => dbMocks);

import { getEnabledTools } from '../src/ai/tools.js';
import { config } from '../src/utils/config.js';

function makeSong(overrides: Partial<Song> = {}): Song {
  return {
    id: 1,
    title: 'Sundown',
    key: 'E',
    tempo: 120,
    status: 'gig-ready',
    notes: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeRehearsal(overrides: Partial<Rehearsal> = {}): Rehearsal {
  return {
    id: 1,
    scheduledAt: 1_800_000_000,
    location: 'The Garage',
    agenda: null,
    status: 'scheduled',
    reminderSent: false,
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeAvailability(overrides: Partial<Availability> = {}): Availability {
  return {
    id: 1,
    rehearsalId: 1,
    memberId: 'member1',
    memberName: 'Alice',
    response: 'yes',
    respondedAt: 0,
    ...overrides,
  };
}

function makeSetlist(overrides: Partial<Setlist> = {}): Setlist {
  return {
    id: 1,
    name: 'Summer Gig',
    notes: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeSetlistEntry(overrides: Partial<SetlistEntry> = {}): SetlistEntry {
  return {
    position: 1,
    song: makeSong(),
    ...overrides,
  };
}

describe('practice tools', () => {
  let original: { aiToolCalling: boolean; bandFeaturesEnabled: boolean };

  beforeEach(() => {
    original = {
      aiToolCalling: config.AI_TOOL_CALLING,
      bandFeaturesEnabled: config.BAND_FEATURES_ENABLED,
    };
    dbMocks.getNextRehearsal.mockReset();
    dbMocks.listAvailability.mockReset();
    dbMocks.listSetlists.mockReset();
    dbMocks.getSetlistByName.mockReset();
    dbMocks.getSetlistSongs.mockReset();
  });

  afterEach(() => {
    config.AI_TOOL_CALLING = original.aiToolCalling;
    config.BAND_FEATURES_ENABLED = original.bandFeaturesEnabled;
  });

  describe('getEnabledTools gating', () => {
    it('includes next_rehearsal and current_setlist when BAND_FEATURES_ENABLED is true', () => {
      config.AI_TOOL_CALLING = true;
      config.BAND_FEATURES_ENABLED = true;

      const names = getEnabledTools().map((t) => t.name);

      expect(names).toContain('next_rehearsal');
      expect(names).toContain('current_setlist');
    });

    it('excludes both practice tools when BAND_FEATURES_ENABLED is false', () => {
      config.AI_TOOL_CALLING = true;
      config.BAND_FEATURES_ENABLED = false;

      const names = getEnabledTools().map((t) => t.name);

      expect(names).not.toContain('next_rehearsal');
      expect(names).not.toContain('current_setlist');
    });

    it('excludes everything (including practice tools) when AI_TOOL_CALLING is false', () => {
      config.AI_TOOL_CALLING = false;
      config.BAND_FEATURES_ENABLED = true;

      expect(getEnabledTools()).toEqual([]);
    });
  });

  describe('next_rehearsal', () => {
    beforeEach(() => {
      config.AI_TOOL_CALLING = true;
      config.BAND_FEATURES_ENABLED = true;
    });

    function getTool() {
      const tool = getEnabledTools().find((t) => t.name === 'next_rehearsal');
      if (!tool) throw new Error('next_rehearsal not enabled');
      return tool;
    }

    it('returns the formatted rehearsal plus an availability summary', async () => {
      dbMocks.getNextRehearsal.mockResolvedValueOnce(makeRehearsal({ id: 7, location: 'The Garage' }));
      dbMocks.listAvailability.mockResolvedValueOnce([
        makeAvailability({ memberName: 'Alice', response: 'yes' }),
        makeAvailability({ memberName: 'Bob', response: 'yes' }),
        makeAvailability({ memberName: 'Cara', response: 'no' }),
        makeAvailability({ memberName: 'Dan', response: 'maybe' }),
      ]);

      const result = await getTool().execute({});

      expect(dbMocks.listAvailability).toHaveBeenCalledWith(7);
      expect(result).toContain('#7');
      expect(result).toContain('The Garage');
      expect(result).toMatch(/Coming:\s*2/);
      expect(result).toMatch(/Out:\s*1/);
      expect(result).toMatch(/Maybe:\s*1/);
    });

    it('reports no availability responses concisely', async () => {
      dbMocks.getNextRehearsal.mockResolvedValueOnce(makeRehearsal({ id: 3 }));
      dbMocks.listAvailability.mockResolvedValueOnce([]);

      const result = await getTool().execute({});

      expect(result).toContain('#3');
      expect(result).not.toMatch(/Coming:/);
    });

    it('returns a clear message when no rehearsal is scheduled', async () => {
      dbMocks.getNextRehearsal.mockResolvedValueOnce(undefined);

      const result = await getTool().execute({});

      expect(result).toMatch(/no rehearsal/i);
      expect(dbMocks.listAvailability).not.toHaveBeenCalled();
    });
  });

  describe('current_setlist', () => {
    beforeEach(() => {
      config.AI_TOOL_CALLING = true;
      config.BAND_FEATURES_ENABLED = true;
    });

    function getTool() {
      const tool = getEnabledTools().find((t) => t.name === 'current_setlist');
      if (!tool) throw new Error('current_setlist not enabled');
      return tool;
    }

    it('looks up a setlist by name when given', async () => {
      dbMocks.getSetlistByName.mockResolvedValueOnce(makeSetlist({ id: 2, name: 'Winter Show' }));
      dbMocks.getSetlistSongs.mockResolvedValueOnce([
        makeSetlistEntry({ position: 1, song: makeSong({ title: 'Sundown' }) }),
      ]);

      const result = await getTool().execute({ name: 'Winter Show' });

      expect(dbMocks.getSetlistByName).toHaveBeenCalledWith('Winter Show');
      expect(dbMocks.getSetlistSongs).toHaveBeenCalledWith(2);
      expect(result).toContain('Winter Show');
      expect(result).toContain('Sundown');
    });

    it('reports when the named setlist is not found', async () => {
      dbMocks.getSetlistByName.mockResolvedValueOnce(undefined);

      const result = await getTool().execute({ name: 'Nonexistent' });

      expect(result).toMatch(/no setlist/i);
      expect(result).toContain('Nonexistent');
      expect(dbMocks.getSetlistSongs).not.toHaveBeenCalled();
    });

    it('defaults to the most recently created setlist when no name is given', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([
        makeSetlist({ id: 1, name: 'Spring Gig', createdAt: 100 }),
        makeSetlist({ id: 3, name: 'Fall Gig', createdAt: 300 }),
        makeSetlist({ id: 2, name: 'Summer Gig', createdAt: 200 }),
      ]);
      dbMocks.getSetlistSongs.mockResolvedValueOnce([
        makeSetlistEntry({ position: 1, song: makeSong({ title: 'Chickpea Boogie' }) }),
      ]);

      const result = await getTool().execute({});

      expect(dbMocks.getSetlistSongs).toHaveBeenCalledWith(3);
      expect(result).toContain('Fall Gig');
      expect(result).toContain('Chickpea Boogie');
    });

    it('returns a clear message when there are no setlists at all', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([]);

      const result = await getTool().execute({});

      expect(result).toMatch(/no setlist/i);
      expect(dbMocks.getSetlistSongs).not.toHaveBeenCalled();
    });
  });
});
