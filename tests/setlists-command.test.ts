process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Setlist, SetlistEntry, Song } from '../src/utils/db-types.js';

const dbMocks = vi.hoisted(() => ({
  addSetlist: vi.fn(),
  getSetlistByName: vi.fn(),
  listSetlists: vi.fn(),
  deleteSetlist: vi.fn(),
  addSongToSetlist: vi.fn(),
  removeSongFromSetlist: vi.fn(),
  moveSetlistSong: vi.fn(),
  getSetlistSongs: vi.fn(),
  getSongByTitle: vi.fn(),
}));

vi.mock('../src/utils/db.js', () => dbMocks);

import { formatSetlist, handleSetlistCommand } from '../src/features/setlists.js';

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

function makeEntry(overrides: Partial<SetlistEntry> = {}): SetlistEntry {
  return {
    position: 1,
    song: makeSong(),
    ...overrides,
  };
}

describe('formatSetlist', () => {
  it('renders a header with name and notes, then a numbered list of songs', () => {
    const setlist = makeSetlist({ name: 'Summer Gig', notes: 'outdoor set' });
    const entries = [
      makeEntry({ position: 1, song: makeSong({ title: 'Sundown' }) }),
      makeEntry({ position: 2, song: makeSong({ title: 'Chickpea Boogie', key: null, tempo: null, status: 'idea' }) }),
    ];

    const result = formatSetlist(setlist, entries);

    expect(result).toContain('Summer Gig');
    expect(result).toContain('outdoor set');
    expect(result).toContain('1. Sundown (E, 120bpm, gig-ready)');
    expect(result).toContain('2. Chickpea Boogie (idea)');
  });

  it('omits notes when null', () => {
    const setlist = makeSetlist({ notes: null });
    const result = formatSetlist(setlist, []);
    expect(result).not.toMatch(/null/i);
  });

  it('shows a friendly (empty) message when there are no entries', () => {
    const result = formatSetlist(makeSetlist(), []);
    expect(result).toMatch(/\(empty\)/i);
  });
});

describe('handleSetlistCommand', () => {
  beforeEach(() => {
    dbMocks.addSetlist.mockReset();
    dbMocks.getSetlistByName.mockReset();
    dbMocks.listSetlists.mockReset();
    dbMocks.deleteSetlist.mockReset();
    dbMocks.addSongToSetlist.mockReset();
    dbMocks.removeSongFromSetlist.mockReset();
    dbMocks.moveSetlistSong.mockReset();
    dbMocks.getSetlistSongs.mockReset();
    dbMocks.getSongByTitle.mockReset();
  });

  describe('create', () => {
    it('creates a setlist and confirms', async () => {
      dbMocks.getSetlistByName.mockResolvedValueOnce(undefined);
      dbMocks.addSetlist.mockResolvedValueOnce(makeSetlist({ name: 'Summer Gig', notes: 'outdoor set' }));

      const result = await handleSetlistCommand('create Summer Gig notes=outdoor set');

      expect(dbMocks.getSetlistByName).toHaveBeenCalledWith('Summer Gig');
      expect(dbMocks.addSetlist).toHaveBeenCalledWith({ name: 'Summer Gig', notes: 'outdoor set' });
      expect(result).toMatch(/created|added/i);
      expect(result).toContain('Summer Gig');
    });

    it('creates a setlist with no notes', async () => {
      dbMocks.getSetlistByName.mockResolvedValueOnce(undefined);
      dbMocks.addSetlist.mockResolvedValueOnce(makeSetlist({ name: 'Fall Gig', notes: null }));

      await handleSetlistCommand('create Fall Gig');

      expect(dbMocks.addSetlist).toHaveBeenCalledWith({ name: 'Fall Gig', notes: undefined });
    });

    it('rejects an empty name without calling addSetlist', async () => {
      const result = await handleSetlistCommand('create notes=outdoor');

      expect(dbMocks.addSetlist).not.toHaveBeenCalled();
      expect(result).toMatch(/usage/i);
    });

    it('rejects a duplicate name without calling addSetlist', async () => {
      dbMocks.getSetlistByName.mockResolvedValueOnce(makeSetlist({ name: 'Summer Gig' }));

      const result = await handleSetlistCommand('create Summer Gig');

      expect(dbMocks.addSetlist).not.toHaveBeenCalled();
      expect(result).toMatch(/already exists/i);
    });
  });

  describe('list', () => {
    it('renders all setlists', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([
        makeSetlist({ id: 1, name: 'Summer Gig' }),
        makeSetlist({ id: 2, name: 'Fall Gig' }),
      ]);

      const result = await handleSetlistCommand('list');

      expect(result).toContain('Summer Gig');
      expect(result).toContain('Fall Gig');
    });

    it('shows a friendly empty message', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([]);

      const result = await handleSetlistCommand('list');

      expect(result).toMatch(/no setlists/i);
    });
  });

  describe('show', () => {
    it('renders a setlist and its songs', async () => {
      dbMocks.getSetlistByName.mockResolvedValueOnce(makeSetlist({ id: 1, name: 'Summer Gig' }));
      dbMocks.getSetlistSongs.mockResolvedValueOnce([
        makeEntry({ position: 1, song: makeSong({ title: 'Sundown' }) }),
      ]);

      const result = await handleSetlistCommand('show Summer Gig');

      expect(dbMocks.getSetlistByName).toHaveBeenCalledWith('Summer Gig');
      expect(dbMocks.getSetlistSongs).toHaveBeenCalledWith(1);
      expect(result).toContain('Summer Gig');
      expect(result).toContain('1. Sundown');
    });

    it('returns a not-found message for a missing setlist', async () => {
      dbMocks.getSetlistByName.mockResolvedValueOnce(undefined);

      const result = await handleSetlistCommand('show Nonexistent');

      expect(dbMocks.getSetlistSongs).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no setlist/i);
    });
  });

  describe('add', () => {
    it('resolves setlist by name and song by title, then appends', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 7, title: 'Sundown' }));
      dbMocks.addSongToSetlist.mockResolvedValueOnce({ id: 1, setlistId: 1, songId: 7, position: 1 });

      const result = await handleSetlistCommand('add SummerGig Sundown');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Sundown');
      expect(dbMocks.addSongToSetlist).toHaveBeenCalledWith(1, 7, undefined);
      expect(result).toMatch(/added/i);
      expect(result).toContain('Sundown');
    });

    it('parses a multi-word song title and an explicit position', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 8, title: 'Chickpea Boogie' }));
      dbMocks.addSongToSetlist.mockResolvedValueOnce({ id: 2, setlistId: 1, songId: 8, position: 2 });

      const result = await handleSetlistCommand('add SummerGig Chickpea Boogie position=2');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Chickpea Boogie');
      expect(dbMocks.addSongToSetlist).toHaveBeenCalledWith(1, 8, 2);
      expect(result).toMatch(/added/i);
    });

    it('resolves a multi-word setlist name by longest-prefix match', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'Summer Gig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 7, title: 'Sundown' }));
      dbMocks.addSongToSetlist.mockResolvedValueOnce({ id: 1, setlistId: 1, songId: 7, position: 1 });

      const result = await handleSetlistCommand('add Summer Gig Sundown');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Sundown');
      expect(dbMocks.addSongToSetlist).toHaveBeenCalledWith(1, 7, undefined);
      expect(result).toMatch(/added/i);
      expect(result).toContain('Summer Gig');
    });

    it('resolves a multi-word setlist name AND a multi-word song title together', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'Summer Gig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 8, title: 'Chickpea Boogie' }));
      dbMocks.addSongToSetlist.mockResolvedValueOnce({ id: 2, setlistId: 1, songId: 8, position: 2 });

      const result = await handleSetlistCommand('add Summer Gig Chickpea Boogie position=2');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Chickpea Boogie');
      expect(dbMocks.addSongToSetlist).toHaveBeenCalledWith(1, 8, 2);
      expect(result).toMatch(/added/i);
    });

    it('picks the longer of two setlists sharing a leading word (longest-prefix wins)', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([
        makeSetlist({ id: 1, name: 'Summer' }),
        makeSetlist({ id: 2, name: 'Summer Gig' }),
      ]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 7, title: 'Sundown' }));
      dbMocks.addSongToSetlist.mockResolvedValueOnce({ id: 1, setlistId: 2, songId: 7, position: 1 });

      const result = await handleSetlistCommand('add Summer Gig Sundown');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Sundown');
      expect(dbMocks.addSongToSetlist).toHaveBeenCalledWith(2, 7, undefined);
      expect(result).toContain('Summer Gig');
    });

    it('returns a not-found message for an unknown setlist without calling getSongByTitle', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);

      const result = await handleSetlistCommand('add Nonexistent Sundown');

      expect(dbMocks.getSongByTitle).not.toHaveBeenCalled();
      expect(dbMocks.addSongToSetlist).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no setlist/i);
    });

    it('returns a not-found message for an unknown song', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(undefined);

      const result = await handleSetlistCommand('add SummerGig Nonexistent Song');

      expect(dbMocks.addSongToSetlist).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no song/i);
    });

    it('rejects an invalid position without calling listSetlists or addSongToSetlist', async () => {
      const result = await handleSetlistCommand('add SummerGig Sundown position=0');

      expect(dbMocks.listSetlists).not.toHaveBeenCalled();
      expect(dbMocks.addSongToSetlist).not.toHaveBeenCalled();
      expect(result).toMatch(/position/i);
    });
  });

  describe('remove', () => {
    it('removes a song from a setlist', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 7, title: 'Sundown' }));
      dbMocks.removeSongFromSetlist.mockResolvedValueOnce(true);

      const result = await handleSetlistCommand('remove SummerGig Sundown');

      expect(dbMocks.removeSongFromSetlist).toHaveBeenCalledWith(1, 7);
      expect(result).toMatch(/removed/i);
    });

    it('resolves a multi-word setlist name by longest-prefix match', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'Summer Gig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 7, title: 'Sundown' }));
      dbMocks.removeSongFromSetlist.mockResolvedValueOnce(true);

      const result = await handleSetlistCommand('remove Summer Gig Sundown');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Sundown');
      expect(dbMocks.removeSongFromSetlist).toHaveBeenCalledWith(1, 7);
      expect(result).toMatch(/removed/i);
      expect(result).toContain('Summer Gig');
    });

    it('picks the longer of two setlists sharing a leading word (longest-prefix wins)', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([
        makeSetlist({ id: 1, name: 'Summer' }),
        makeSetlist({ id: 2, name: 'Summer Gig' }),
      ]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 7, title: 'Sundown' }));
      dbMocks.removeSongFromSetlist.mockResolvedValueOnce(true);

      const result = await handleSetlistCommand('remove Summer Gig Sundown');

      expect(dbMocks.removeSongFromSetlist).toHaveBeenCalledWith(2, 7);
      expect(result).toContain('Summer Gig');
    });

    it('returns a not-found message for an unknown setlist', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);

      const result = await handleSetlistCommand('remove Nonexistent Sundown');

      expect(dbMocks.getSongByTitle).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no setlist/i);
    });

    it('returns a not-found message for an unknown song', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(undefined);

      const result = await handleSetlistCommand('remove SummerGig Nonexistent Song');

      expect(dbMocks.removeSongFromSetlist).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no song/i);
    });

    it('returns a friendly message when the song is not on the setlist', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 7, title: 'Sundown' }));
      dbMocks.removeSongFromSetlist.mockResolvedValueOnce(false);

      const result = await handleSetlistCommand('remove SummerGig Sundown');

      expect(result).toMatch(/not (found|on|in)/i);
    });
  });

  describe('move', () => {
    it('reorders a song to a new position', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 7, title: 'Sundown' }));
      dbMocks.moveSetlistSong.mockResolvedValueOnce(true);

      const result = await handleSetlistCommand('move SummerGig Sundown 1');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Sundown');
      expect(dbMocks.moveSetlistSong).toHaveBeenCalledWith(1, 7, 1);
      expect(result).toMatch(/moved|updated/i);
    });

    it('parses a multi-word song title with a trailing position', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 8, title: 'Chickpea Boogie' }));
      dbMocks.moveSetlistSong.mockResolvedValueOnce(true);

      const result = await handleSetlistCommand('move SummerGig Chickpea Boogie 3');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Chickpea Boogie');
      expect(dbMocks.moveSetlistSong).toHaveBeenCalledWith(1, 8, 3);
      expect(result).toMatch(/moved|updated/i);
    });

    it('resolves a multi-word setlist name, picking the longer of two setlists sharing a leading word', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([
        makeSetlist({ id: 1, name: 'Summer' }),
        makeSetlist({ id: 2, name: 'Summer Gig' }),
      ]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 7, title: 'Sundown' }));
      dbMocks.moveSetlistSong.mockResolvedValueOnce(true);

      const result = await handleSetlistCommand('move Summer Gig Sundown 2');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Sundown');
      expect(dbMocks.moveSetlistSong).toHaveBeenCalledWith(2, 7, 2);
      expect(result).toMatch(/moved|updated/i);
      expect(result).toContain('Summer Gig');
    });

    it('rejects a bad (non-integer, zero, or negative) position without calling moveSetlistSong', async () => {
      dbMocks.listSetlists.mockResolvedValue([makeSetlist({ id: 1, name: 'SummerGig' })]);
      dbMocks.getSongByTitle.mockResolvedValue(makeSong({ id: 7, title: 'Sundown' }));

      for (const bad of ['move SummerGig Sundown', 'move SummerGig Sundown 0', 'move SummerGig Sundown -1', 'move SummerGig Sundown abc']) {
        dbMocks.moveSetlistSong.mockClear();
        const result = await handleSetlistCommand(bad);
        expect(dbMocks.moveSetlistSong).not.toHaveBeenCalled();
        expect(result).toMatch(/usage|position/i);
      }
    });

    it('returns a not-found message for an unknown setlist', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);

      const result = await handleSetlistCommand('move Nonexistent Sundown 1');

      expect(dbMocks.getSongByTitle).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no setlist/i);
    });

    it('returns a not-found message for an unknown song', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(undefined);

      const result = await handleSetlistCommand('move SummerGig Nonexistent Song 1');

      expect(dbMocks.moveSetlistSong).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no song/i);
    });

    it('returns a friendly message when the song is not on the setlist', async () => {
      dbMocks.listSetlists.mockResolvedValueOnce([makeSetlist({ id: 1, name: 'SummerGig' })]);
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 7, title: 'Sundown' }));
      dbMocks.moveSetlistSong.mockResolvedValueOnce(false);

      const result = await handleSetlistCommand('move SummerGig Sundown 1');

      expect(result).toMatch(/not (found|on|in)/i);
    });
  });

  describe('delete', () => {
    it('deletes a setlist found by name', async () => {
      dbMocks.getSetlistByName.mockResolvedValueOnce(makeSetlist({ id: 1, name: 'Summer Gig' }));
      dbMocks.deleteSetlist.mockResolvedValueOnce(true);

      const result = await handleSetlistCommand('delete Summer Gig');

      expect(dbMocks.getSetlistByName).toHaveBeenCalledWith('Summer Gig');
      expect(dbMocks.deleteSetlist).toHaveBeenCalledWith(1);
      expect(result).toMatch(/deleted/i);
    });

    it('returns a not-found message for a missing setlist', async () => {
      dbMocks.getSetlistByName.mockResolvedValueOnce(undefined);

      const result = await handleSetlistCommand('delete Nonexistent');

      expect(dbMocks.deleteSetlist).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no setlist/i);
    });
  });

  describe('unknown/empty subcommand', () => {
    it('returns a usage string for an unknown subcommand', async () => {
      const result = await handleSetlistCommand('frobnicate Summer Gig');

      expect(result).toMatch(/usage|commands/i);
      expect(result).toMatch(/create/);
      expect(result).toMatch(/list/);
      expect(result).toMatch(/show/);
      expect(result).toMatch(/add/);
      expect(result).toMatch(/remove/);
      expect(result).toMatch(/move/);
      expect(result).toMatch(/delete/);
    });

    it('returns a usage string for empty args', async () => {
      const result = await handleSetlistCommand('');

      expect(result).toMatch(/usage|commands/i);
    });
  });
});
