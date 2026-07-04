process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../src/utils/db-types.js';

const dbMocks = vi.hoisted(() => ({
  addSong: vi.fn(),
  getSongById: vi.fn(),
  getSongByTitle: vi.fn(),
  listSongs: vi.fn(),
  updateSong: vi.fn(),
  deleteSong: vi.fn(),
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

describe('band tools', () => {
  let original: { aiToolCalling: boolean; bandFeaturesEnabled: boolean };

  beforeEach(() => {
    original = {
      aiToolCalling: config.AI_TOOL_CALLING,
      bandFeaturesEnabled: config.BAND_FEATURES_ENABLED,
    };
    dbMocks.addSong.mockReset();
    dbMocks.getSongById.mockReset();
    dbMocks.getSongByTitle.mockReset();
    dbMocks.listSongs.mockReset();
    dbMocks.updateSong.mockReset();
    dbMocks.deleteSong.mockReset();
  });

  afterEach(() => {
    config.AI_TOOL_CALLING = original.aiToolCalling;
    config.BAND_FEATURES_ENABLED = original.bandFeaturesEnabled;
  });

  describe('getEnabledTools gating', () => {
    it('includes list_band_songs and find_band_song when BAND_FEATURES_ENABLED is true', () => {
      config.AI_TOOL_CALLING = true;
      config.BAND_FEATURES_ENABLED = true;

      const names = getEnabledTools().map((t) => t.name);

      expect(names).toContain('list_band_songs');
      expect(names).toContain('find_band_song');
    });

    it('excludes both band tools when BAND_FEATURES_ENABLED is false', () => {
      config.AI_TOOL_CALLING = true;
      config.BAND_FEATURES_ENABLED = false;

      const names = getEnabledTools().map((t) => t.name);

      expect(names).not.toContain('list_band_songs');
      expect(names).not.toContain('find_band_song');
    });

    it('excludes everything (including band tools) when AI_TOOL_CALLING is false', () => {
      config.AI_TOOL_CALLING = false;
      config.BAND_FEATURES_ENABLED = true;

      expect(getEnabledTools()).toEqual([]);
    });
  });

  describe('list_band_songs', () => {
    beforeEach(() => {
      config.AI_TOOL_CALLING = true;
      config.BAND_FEATURES_ENABLED = true;
    });

    function getTool() {
      const tool = getEnabledTools().find((t) => t.name === 'list_band_songs');
      if (!tool) throw new Error('list_band_songs not enabled');
      return tool;
    }

    it('lists all songs formatted via formatSongLine when no status is given', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([
        makeSong({ id: 1, title: 'Sundown', key: 'E', tempo: 120, status: 'gig-ready' }),
        makeSong({ id: 2, title: 'Chickpea Boogie', key: null, tempo: null, status: 'idea' }),
      ]);

      const result = await getTool().execute({});

      expect(dbMocks.listSongs).toHaveBeenCalledWith(undefined);
      expect(result).toContain('Sundown (E, 120bpm, gig-ready)');
      expect(result).toContain('Chickpea Boogie (idea)');
    });

    it('passes a valid status filter through to listSongs', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([
        makeSong({ id: 2, title: 'Chickpea Boogie', key: null, tempo: null, status: 'idea' }),
      ]);

      const result = await getTool().execute({ status: 'idea' });

      expect(dbMocks.listSongs).toHaveBeenCalledWith('idea');
      expect(result).toContain('Chickpea Boogie (idea)');
    });

    it('ignores an invalid status gracefully instead of throwing or erroring', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong()]);

      const result = await getTool().execute({ status: 'lit' });

      expect(dbMocks.listSongs).toHaveBeenCalledWith(undefined);
      expect(result).toContain('Sundown');
    });

    it('returns a no-songs message when the catalog is empty', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([]);

      const result = await getTool().execute({});

      expect(result).toMatch(/no songs/i);
    });

    it('returns a status-scoped no-songs message when filtered and empty', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([]);

      const result = await getTool().execute({ status: 'tight' });

      expect(result).toMatch(/tight/);
    });
  });

  describe('find_band_song', () => {
    beforeEach(() => {
      config.AI_TOOL_CALLING = true;
      config.BAND_FEATURES_ENABLED = true;
    });

    function getTool() {
      const tool = getEnabledTools().find((t) => t.name === 'find_band_song');
      if (!tool) throw new Error('find_band_song not enabled');
      return tool;
    }

    it('finds an exact case-insensitive match', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([
        makeSong({ id: 1, title: 'Sundown', status: 'gig-ready' }),
        makeSong({ id: 2, title: 'Chickpea Boogie', key: null, tempo: null, status: 'idea' }),
      ]);

      const result = await getTool().execute({ title: 'sundown' });

      expect(result).toContain('Sundown (E, 120bpm, gig-ready)');
      expect(result).not.toContain('Chickpea Boogie');
    });

    it('fuzzy-matches a substring of the title', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([
        makeSong({ id: 2, title: 'Chickpea Boogie', key: null, tempo: null, status: 'idea' }),
      ]);

      const result = await getTool().execute({ title: 'boogie' });

      expect(result).toContain('Chickpea Boogie (idea)');
    });

    it('reports no match when nothing fuzzy-matches', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([
        makeSong({ id: 1, title: 'Sundown', status: 'gig-ready' }),
      ]);

      const result = await getTool().execute({ title: 'Nonexistent Tune' });

      expect(result).toMatch(/no song/i);
      expect(result).toContain('Nonexistent Tune');
    });

    it('rejects an empty title without calling listSongs', async () => {
      const result = await getTool().execute({ title: '   ' });

      expect(dbMocks.listSongs).not.toHaveBeenCalled();
      expect(result).toMatch(/title/i);
    });
  });
});
