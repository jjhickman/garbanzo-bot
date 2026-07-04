process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song, SongIdea, SongSection } from '../src/utils/db-types.js';

const dbMocks = vi.hoisted(() => ({
  getSongByTitle: vi.fn(),
  getSongSections: vi.fn(),
  listSongIdeas: vi.fn(),
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

function makeSection(overrides: Partial<SongSection> = {}): SongSection {
  return {
    id: 1,
    songId: 1,
    kind: 'verse',
    position: 1,
    lyrics: 'walking home at sundown',
    chords: 'G D Em C',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeIdea(overrides: Partial<SongIdea> = {}): SongIdea {
  return {
    id: 1,
    title: 'Ocean riff',
    text: 'verse about waves',
    audioUrl: null,
    transcript: null,
    songId: null,
    createdBy: 'member1',
    createdAt: 0,
    ...overrides,
  };
}

describe('songwriting tools', () => {
  let original: { aiToolCalling: boolean; bandFeaturesEnabled: boolean };

  beforeEach(() => {
    original = {
      aiToolCalling: config.AI_TOOL_CALLING,
      bandFeaturesEnabled: config.BAND_FEATURES_ENABLED,
    };
    dbMocks.getSongByTitle.mockReset();
    dbMocks.getSongSections.mockReset();
    dbMocks.listSongIdeas.mockReset();
  });

  afterEach(() => {
    config.AI_TOOL_CALLING = original.aiToolCalling;
    config.BAND_FEATURES_ENABLED = original.bandFeaturesEnabled;
  });

  describe('getEnabledTools gating', () => {
    it('includes get_song_sections and list_song_ideas when BAND_FEATURES_ENABLED is true', () => {
      config.AI_TOOL_CALLING = true;
      config.BAND_FEATURES_ENABLED = true;

      const names = getEnabledTools().map((t) => t.name);

      expect(names).toContain('get_song_sections');
      expect(names).toContain('list_song_ideas');
    });

    it('excludes both songwriting tools when BAND_FEATURES_ENABLED is false', () => {
      config.AI_TOOL_CALLING = true;
      config.BAND_FEATURES_ENABLED = false;

      const names = getEnabledTools().map((t) => t.name);

      expect(names).not.toContain('get_song_sections');
      expect(names).not.toContain('list_song_ideas');
    });

    it('excludes everything (including songwriting tools) when AI_TOOL_CALLING is false', () => {
      config.AI_TOOL_CALLING = false;
      config.BAND_FEATURES_ENABLED = true;

      expect(getEnabledTools()).toEqual([]);
    });
  });

  describe('get_song_sections', () => {
    beforeEach(() => {
      config.AI_TOOL_CALLING = true;
      config.BAND_FEATURES_ENABLED = true;
    });

    function getTool() {
      const tool = getEnabledTools().find((t) => t.name === 'get_song_sections');
      if (!tool) throw new Error('get_song_sections not enabled');
      return tool;
    }

    it('returns the formatted song sheet for a found song with sections', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 5, title: 'Sundown' }));
      dbMocks.getSongSections.mockResolvedValueOnce([
        makeSection({ id: 1, songId: 5, position: 1, kind: 'verse', lyrics: 'walking home at sundown' }),
      ]);

      const result = await getTool().execute({ title: 'Sundown' });

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Sundown');
      expect(dbMocks.getSongSections).toHaveBeenCalledWith(5);
      expect(result).toContain('Sundown');
      expect(result).toContain('walking home at sundown');
    });

    it('reports a friendly message when the song has no sections yet', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 5, title: 'Sundown' }));
      dbMocks.getSongSections.mockResolvedValueOnce([]);

      const result = await getTool().execute({ title: 'Sundown' });

      expect(result).toContain('Sundown');
      expect(result).toMatch(/no sections yet/i);
    });

    it('reports no song found when the title does not match', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(undefined);

      const result = await getTool().execute({ title: 'Nonexistent Tune' });

      expect(result).toMatch(/no song/i);
      expect(result).toContain('Nonexistent Tune');
      expect(dbMocks.getSongSections).not.toHaveBeenCalled();
    });

    it('rejects an empty title without calling the db', async () => {
      const result = await getTool().execute({ title: '   ' });

      expect(dbMocks.getSongByTitle).not.toHaveBeenCalled();
      expect(result).toMatch(/title/i);
    });
  });

  describe('list_song_ideas', () => {
    beforeEach(() => {
      config.AI_TOOL_CALLING = true;
      config.BAND_FEATURES_ENABLED = true;
    });

    function getTool() {
      const tool = getEnabledTools().find((t) => t.name === 'list_song_ideas');
      if (!tool) throw new Error('list_song_ideas not enabled');
      return tool;
    }

    it('returns formatted idea lines', async () => {
      dbMocks.listSongIdeas.mockResolvedValueOnce([
        makeIdea({ id: 1, title: 'Ocean riff', text: 'verse about waves' }),
        makeIdea({ id: 2, title: null, text: 'chickpea highway chorus' }),
      ]);

      const result = await getTool().execute({});

      expect(dbMocks.listSongIdeas).toHaveBeenCalledWith(expect.any(Number));
      expect(result).toContain('#1');
      expect(result).toContain('Ocean riff');
      expect(result).toContain('verse about waves');
      expect(result).toContain('#2');
      expect(result).toContain('chickpea highway chorus');
    });

    it('returns a no-ideas message when there are none captured yet', async () => {
      dbMocks.listSongIdeas.mockResolvedValueOnce([]);

      const result = await getTool().execute({});

      expect(result).toMatch(/no song ideas/i);
    });
  });
});
