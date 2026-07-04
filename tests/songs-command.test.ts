process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { formatSongLine, handleSongCommand } from '../src/features/songs.js';

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

describe('formatSongLine', () => {
  it('renders key, tempo and status when all present', () => {
    expect(formatSongLine(makeSong())).toBe('Sundown (E, 120bpm, gig-ready)');
  });

  it('omits key and tempo when null', () => {
    expect(formatSongLine(makeSong({ key: null, tempo: null }))).toBe('Sundown (gig-ready)');
  });

  it('omits only the missing field when just one is null', () => {
    expect(formatSongLine(makeSong({ tempo: null }))).toBe('Sundown (E, gig-ready)');
    expect(formatSongLine(makeSong({ key: null }))).toBe('Sundown (120bpm, gig-ready)');
  });
});

describe('handleSongCommand', () => {
  beforeEach(() => {
    dbMocks.addSong.mockReset();
    dbMocks.getSongById.mockReset();
    dbMocks.getSongByTitle.mockReset();
    dbMocks.listSongs.mockReset();
    dbMocks.updateSong.mockReset();
    dbMocks.deleteSong.mockReset();
  });

  describe('add', () => {
    it('parses title, key, tempo and status tokens anywhere after the title', async () => {
      dbMocks.addSong.mockResolvedValueOnce(makeSong({ title: 'Sundown', key: 'E', tempo: 120, status: 'gig-ready' }));

      const result = await handleSongCommand('add Sundown key=E tempo=120 status=gig-ready');

      expect(dbMocks.addSong).toHaveBeenCalledWith({
        title: 'Sundown',
        key: 'E',
        tempo: 120,
        status: 'gig-ready',
      });
      expect(result).toContain('Sundown (E, 120bpm, gig-ready)');
    });

    it('parses a multi-word title', async () => {
      dbMocks.addSong.mockResolvedValueOnce(makeSong({ title: 'Sweet Garbanzo Sunrise', key: null, tempo: null }));

      await handleSongCommand('add Sweet Garbanzo Sunrise status=idea');

      expect(dbMocks.addSong).toHaveBeenCalledWith({
        title: 'Sweet Garbanzo Sunrise',
        key: undefined,
        tempo: undefined,
        status: 'idea',
      });
    });

    it('adds with just a title and no fields', async () => {
      dbMocks.addSong.mockResolvedValueOnce(makeSong({ title: 'Falafel Fever', key: null, tempo: null, status: 'idea' }));

      const result = await handleSongCommand('add Falafel Fever');

      expect(dbMocks.addSong).toHaveBeenCalledWith({
        title: 'Falafel Fever',
        key: undefined,
        tempo: undefined,
        status: undefined,
      });
      expect(result).toMatch(/Falafel Fever/);
    });

    it('rejects a bad status without calling addSong', async () => {
      const result = await handleSongCommand('add Sundown status=lit');

      expect(dbMocks.addSong).not.toHaveBeenCalled();
      expect(result).toMatch(/status/i);
      expect(result).toMatch(/idea|rough|tight|gig-ready/);
    });

    it('rejects an empty title without calling addSong', async () => {
      const result = await handleSongCommand('add key=E');

      expect(dbMocks.addSong).not.toHaveBeenCalled();
      expect(result).toMatch(/usage/i);
    });

    it('rejects a non-numeric tempo', async () => {
      const result = await handleSongCommand('add Sundown tempo=fast');

      expect(dbMocks.addSong).not.toHaveBeenCalled();
      expect(result).toMatch(/tempo/i);
    });

    it('rejects a blank, zero, or negative tempo instead of storing 0', async () => {
      for (const bad of ['add Sundown tempo=', 'add Sundown tempo=0', 'add Sundown tempo=-40']) {
        dbMocks.addSong.mockClear();
        const result = await handleSongCommand(bad);
        expect(dbMocks.addSong).not.toHaveBeenCalled();
        expect(result).toMatch(/tempo/i);
      }
    });
  });

  describe('list', () => {
    it('renders all songs grouped when no status filter is given', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([
        makeSong({ id: 1, title: 'Sundown', status: 'gig-ready' }),
        makeSong({ id: 2, title: 'Chickpea Boogie', key: null, tempo: null, status: 'idea' }),
      ]);

      const result = await handleSongCommand('list');

      expect(dbMocks.listSongs).toHaveBeenCalledWith(undefined);
      expect(result).toContain('Sundown (E, 120bpm, gig-ready)');
      expect(result).toContain('Chickpea Boogie (idea)');
    });

    it('filters by status', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([
        makeSong({ id: 2, title: 'Chickpea Boogie', key: null, tempo: null, status: 'idea' }),
      ]);

      const result = await handleSongCommand('list idea');

      expect(dbMocks.listSongs).toHaveBeenCalledWith('idea');
      expect(result).toContain('Chickpea Boogie (idea)');
    });

    it('rejects an invalid status filter', async () => {
      const result = await handleSongCommand('list nonsense');

      expect(dbMocks.listSongs).not.toHaveBeenCalled();
      expect(result).toMatch(/status/i);
    });

    it('shows a friendly empty message when there are no songs', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([]);

      const result = await handleSongCommand('list');

      expect(result).toMatch(/no songs/i);
    });

    it('shows a friendly empty message scoped to the filtered status', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([]);

      const result = await handleSongCommand('list tight');

      expect(result).toMatch(/tight/);
    });
  });

  describe('show', () => {
    it('renders a single song with its notes', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ notes: 'needs a bridge' }));

      const result = await handleSongCommand('show Sundown');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Sundown');
      expect(result).toContain('Sundown (E, 120bpm, gig-ready)');
      expect(result).toContain('needs a bridge');
    });

    it('returns a not-found message for a missing title', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(undefined);

      const result = await handleSongCommand('show Nonexistent Song');

      expect(result).toMatch(/not found|no song/i);
    });
  });

  describe('set', () => {
    it('updates only the provided fields', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 5 }));
      dbMocks.updateSong.mockResolvedValueOnce(makeSong({ id: 5, tempo: 130, status: 'tight' }));

      const result = await handleSongCommand('set Sundown tempo=130 status=tight');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Sundown');
      expect(dbMocks.updateSong).toHaveBeenCalledWith(5, { tempo: 130, status: 'tight' });
      expect(result).toMatch(/updated/i);
    });

    it('supports updating notes with spaces', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 5 }));
      dbMocks.updateSong.mockResolvedValueOnce(makeSong({ id: 5, notes: 'needs a bridge before the solo' }));

      await handleSongCommand('set Sundown notes=needs a bridge before the solo');

      expect(dbMocks.updateSong).toHaveBeenCalledWith(5, { notes: 'needs a bridge before the solo' });
    });

    it('rejects a bad status without calling updateSong', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 5 }));

      const result = await handleSongCommand('set Sundown status=lit');

      expect(dbMocks.updateSong).not.toHaveBeenCalled();
      expect(result).toMatch(/status/i);
    });

    it('returns a not-found message for a missing title', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(undefined);

      const result = await handleSongCommand('set Nonexistent status=tight');

      expect(dbMocks.updateSong).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no song/i);
    });
  });

  describe('delete', () => {
    it('deletes a song found by title', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 9, title: 'Sundown' }));
      dbMocks.deleteSong.mockResolvedValueOnce(true);

      const result = await handleSongCommand('delete Sundown');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Sundown');
      expect(dbMocks.deleteSong).toHaveBeenCalledWith(9);
      expect(result).toMatch(/deleted/i);
    });

    it('returns a not-found message for a missing title', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(undefined);

      const result = await handleSongCommand('delete Nonexistent Song');

      expect(dbMocks.deleteSong).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no song/i);
    });
  });

  describe('unknown/empty subcommand', () => {
    it('returns a usage string for an unknown subcommand', async () => {
      const result = await handleSongCommand('frobnicate Sundown');

      expect(result).toMatch(/usage|commands/i);
      expect(result).toMatch(/add/);
      expect(result).toMatch(/list/);
      expect(result).toMatch(/show/);
      expect(result).toMatch(/set/);
      expect(result).toMatch(/delete/);
    });

    it('returns a usage string for empty args', async () => {
      const result = await handleSongCommand('');

      expect(result).toMatch(/usage|commands/i);
    });
  });
});
