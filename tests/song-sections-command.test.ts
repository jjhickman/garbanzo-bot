process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song, SongSection } from '../src/utils/db-types.js';

const dbMocks = vi.hoisted(() => ({
  addSongSection: vi.fn(),
  getSongByTitle: vi.fn(),
  getSongSections: vi.fn(),
  listSongs: vi.fn(),
  moveSongSection: vi.fn(),
  removeSongSection: vi.fn(),
  updateSongSection: vi.fn(),
}));

vi.mock('../src/utils/db.js', () => dbMocks);

import {
  formatSection,
  formatSongSheet,
  handleLyricsCommand,
  handleSectionCommand,
} from '../src/features/song-sections.js';

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
    lyrics: null,
    chords: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('formatSection', () => {
  it('renders position, kind, and lyrics', () => {
    const section = makeSection({ position: 2, kind: 'chorus', lyrics: 'hey now chickpea' });
    const result = formatSection(section);
    expect(result).toContain('2.');
    expect(result).toContain('[chorus]');
    expect(result).toContain('hey now chickpea');
  });

  it('includes a chords line when chords are present', () => {
    const section = makeSection({ chords: 'G D Em C' });
    const result = formatSection(section);
    expect(result).toMatch(/chords/i);
    expect(result).toContain('G D Em C');
  });

  it('omits a chords line when chords are null', () => {
    const section = makeSection({ chords: null });
    const result = formatSection(section);
    expect(result).not.toMatch(/chords/i);
  });

  it('handles null lyrics gracefully', () => {
    const section = makeSection({ lyrics: null });
    const result = formatSection(section);
    expect(result).not.toMatch(/null/i);
  });
});

describe('formatSongSheet', () => {
  it('renders a header with the song title, then numbered sections', () => {
    const song = makeSong({ title: 'Sundown' });
    const sections = [
      makeSection({ position: 1, kind: 'intro', lyrics: null }),
      makeSection({ position: 2, kind: 'verse', lyrics: 'chickpeas in the moonlight' }),
    ];

    const result = formatSongSheet(song, sections);

    expect(result).toContain('Sundown');
    expect(result).toContain('1.');
    expect(result).toContain('[intro]');
    expect(result).toContain('2.');
    expect(result).toContain('[verse]');
    expect(result).toContain('chickpeas in the moonlight');
  });

  it('shows a friendly (no sections yet) message when there are no sections', () => {
    const result = formatSongSheet(makeSong(), []);
    expect(result).toMatch(/no sections yet/i);
  });
});

describe('handleSectionCommand', () => {
  beforeEach(() => {
    dbMocks.addSongSection.mockReset();
    dbMocks.getSongByTitle.mockReset();
    dbMocks.getSongSections.mockReset();
    dbMocks.listSongs.mockReset();
    dbMocks.moveSongSection.mockReset();
    dbMocks.removeSongSection.mockReset();
    dbMocks.updateSongSection.mockReset();
  });

  describe('add', () => {
    it('resolves the song, parses kind/lyrics/chords, and confirms', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);
      dbMocks.addSongSection.mockResolvedValueOnce(
        makeSection({ id: 10, songId: 1, kind: 'verse', position: 1, lyrics: 'blue skies', chords: 'G D Em C' }),
      );

      const result = await handleSectionCommand('add Sundown verse lyrics=blue skies chords=G D Em C');

      expect(dbMocks.addSongSection).toHaveBeenCalledWith({
        songId: 1,
        kind: 'verse',
        lyrics: 'blue skies',
        chords: 'G D Em C',
      });
      expect(result).toMatch(/added/i);
      expect(result).toContain('Sundown');
      expect(result).toContain('verse');
    });

    it('resolves a multi-word song title by longest-prefix match', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 2, title: 'Chickpea Boogie' })]);
      dbMocks.addSongSection.mockResolvedValueOnce(
        makeSection({ id: 11, songId: 2, kind: 'chorus', position: 1 }),
      );

      const result = await handleSectionCommand('add Chickpea Boogie chorus');

      expect(dbMocks.addSongSection).toHaveBeenCalledWith({
        songId: 2,
        kind: 'chorus',
        lyrics: undefined,
        chords: undefined,
      });
      expect(result).toMatch(/added/i);
      expect(result).toContain('Chickpea Boogie');
    });

    it('picks the longer of two songs sharing a leading word (longest-prefix wins)', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([
        makeSong({ id: 1, title: 'Summer' }),
        makeSong({ id: 2, title: 'Summer Nights' }),
      ]);
      dbMocks.addSongSection.mockResolvedValueOnce(makeSection({ id: 12, songId: 2, kind: 'bridge' }));

      const result = await handleSectionCommand('add Summer Nights bridge');

      expect(dbMocks.addSongSection).toHaveBeenCalledWith(
        expect.objectContaining({ songId: 2, kind: 'bridge' }),
      );
      expect(result).toContain('Summer Nights');
    });

    it('rejects an invalid kind without calling addSongSection', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);

      const result = await handleSectionCommand('add Sundown notarealkind');

      expect(dbMocks.addSongSection).not.toHaveBeenCalled();
      expect(result).toMatch(/kind/i);
    });

    it('returns a not-found message for an unknown song', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);

      const result = await handleSectionCommand('add Nonexistent verse');

      expect(dbMocks.addSongSection).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no song/i);
    });
  });

  describe('list', () => {
    it('renders the song sheet for a known song', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 1, title: 'Sundown' }));
      dbMocks.getSongSections.mockResolvedValueOnce([
        makeSection({ position: 1, kind: 'intro' }),
      ]);

      const result = await handleSectionCommand('list Sundown');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Sundown');
      expect(dbMocks.getSongSections).toHaveBeenCalledWith(1);
      expect(result).toContain('Sundown');
      expect(result).toContain('[intro]');
    });

    it('shows a friendly empty message for a song with no sections', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 1, title: 'Sundown' }));
      dbMocks.getSongSections.mockResolvedValueOnce([]);

      const result = await handleSectionCommand('list Sundown');

      expect(result).toMatch(/no sections yet/i);
    });

    it('returns a not-found message for an unknown song', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(undefined);

      const result = await handleSectionCommand('list Nonexistent');

      expect(dbMocks.getSongSections).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no song/i);
    });
  });

  describe('edit', () => {
    it('updates lyrics and chords at a given position', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);
      dbMocks.getSongSections.mockResolvedValueOnce([
        makeSection({ id: 55, position: 1, kind: 'intro' }),
        makeSection({ id: 56, position: 2, kind: 'verse' }),
      ]);
      dbMocks.updateSongSection.mockResolvedValueOnce(
        makeSection({ id: 56, position: 2, kind: 'verse', lyrics: 'new lyrics', chords: 'Am G' }),
      );

      const result = await handleSectionCommand('edit Sundown 2 lyrics=new lyrics chords=Am G');

      expect(dbMocks.updateSongSection).toHaveBeenCalledWith(56, { lyrics: 'new lyrics', chords: 'Am G' });
      expect(result).toMatch(/updated/i);
    });

    it('updates kind when kind= is given and validates it', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);
      dbMocks.getSongSections.mockResolvedValueOnce([
        makeSection({ id: 55, position: 1, kind: 'intro' }),
      ]);
      dbMocks.updateSongSection.mockResolvedValueOnce(makeSection({ id: 55, position: 1, kind: 'chorus' }));

      const result = await handleSectionCommand('edit Sundown 1 kind=chorus');

      expect(dbMocks.updateSongSection).toHaveBeenCalledWith(55, { kind: 'chorus' });
      expect(result).toMatch(/updated/i);
    });

    it('rejects an invalid kind without calling updateSongSection', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);
      dbMocks.getSongSections.mockResolvedValueOnce([
        makeSection({ id: 55, position: 1, kind: 'intro' }),
      ]);

      const result = await handleSectionCommand('edit Sundown 1 kind=notarealkind');

      expect(dbMocks.updateSongSection).not.toHaveBeenCalled();
      expect(result).toMatch(/kind/i);
    });

    it('returns a not-found message for a bad position', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);
      dbMocks.getSongSections.mockResolvedValueOnce([
        makeSection({ id: 55, position: 1, kind: 'intro' }),
      ]);

      const result = await handleSectionCommand('edit Sundown 9 lyrics=nope');

      expect(dbMocks.updateSongSection).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no section/i);
    });

    it('returns a not-found message for an unknown song', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);

      const result = await handleSectionCommand('edit Nonexistent 1 lyrics=nope');

      expect(dbMocks.getSongSections).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no song/i);
    });
  });

  describe('move', () => {
    it('reorders a section to a new position', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);
      dbMocks.getSongSections.mockResolvedValueOnce([
        makeSection({ id: 55, position: 1, kind: 'intro' }),
        makeSection({ id: 56, position: 2, kind: 'verse' }),
      ]);
      dbMocks.moveSongSection.mockResolvedValueOnce(true);

      const result = await handleSectionCommand('move Sundown 2 4');

      expect(dbMocks.moveSongSection).toHaveBeenCalledWith(56, 4);
      expect(result).toMatch(/moved|updated/i);
    });

    it('rejects a bad (non-integer, zero, or negative) position without calling moveSongSection', async () => {
      dbMocks.listSongs.mockResolvedValue([makeSong({ id: 1, title: 'Sundown' })]);
      dbMocks.getSongSections.mockResolvedValue([makeSection({ id: 55, position: 1, kind: 'intro' })]);

      for (const bad of ['move Sundown 1', 'move Sundown 0 1', 'move Sundown 1 -1', 'move Sundown abc 1']) {
        dbMocks.moveSongSection.mockClear();
        const result = await handleSectionCommand(bad);
        expect(dbMocks.moveSongSection).not.toHaveBeenCalled();
        expect(result).toMatch(/usage|position/i);
      }
    });

    it('returns a not-found message for an unknown song', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);

      const result = await handleSectionCommand('move Nonexistent 1 2');

      expect(dbMocks.getSongSections).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no song/i);
    });

    it('returns a not-found message when there is no section at that position', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);
      dbMocks.getSongSections.mockResolvedValueOnce([makeSection({ id: 55, position: 1, kind: 'intro' })]);

      const result = await handleSectionCommand('move Sundown 9 1');

      expect(dbMocks.moveSongSection).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no section/i);
    });
  });

  describe('remove', () => {
    it('removes a section at a position', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);
      dbMocks.getSongSections.mockResolvedValueOnce([
        makeSection({ id: 55, position: 1, kind: 'intro' }),
        makeSection({ id: 56, position: 2, kind: 'verse' }),
      ]);
      dbMocks.removeSongSection.mockResolvedValueOnce(true);

      const result = await handleSectionCommand('remove Sundown 2');

      expect(dbMocks.removeSongSection).toHaveBeenCalledWith(56);
      expect(result).toMatch(/removed/i);
    });

    it('returns a not-found message for a bad position', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);
      dbMocks.getSongSections.mockResolvedValueOnce([makeSection({ id: 55, position: 1, kind: 'intro' })]);

      const result = await handleSectionCommand('remove Sundown 9');

      expect(dbMocks.removeSongSection).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no section/i);
    });

    it('returns a not-found message for an unknown song', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);

      const result = await handleSectionCommand('remove Nonexistent 1');

      expect(dbMocks.getSongSections).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no song/i);
    });
  });

  describe('unknown/empty subcommand', () => {
    it('returns a usage string for an unknown subcommand', async () => {
      const result = await handleSectionCommand('frobnicate Sundown');

      expect(result).toMatch(/usage|commands/i);
      expect(result).toMatch(/add/);
      expect(result).toMatch(/list/);
      expect(result).toMatch(/edit/);
      expect(result).toMatch(/move/);
      expect(result).toMatch(/remove/);
    });

    it('returns a usage string for empty args', async () => {
      const result = await handleSectionCommand('');

      expect(result).toMatch(/usage|commands/i);
    });
  });
});

describe('handleLyricsCommand', () => {
  beforeEach(() => {
    dbMocks.addSongSection.mockReset();
    dbMocks.getSongByTitle.mockReset();
    dbMocks.getSongSections.mockReset();
    dbMocks.listSongs.mockReset();
  });

  describe('show', () => {
    it('renders the lyric sheet for a known song', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(makeSong({ id: 1, title: 'Sundown' }));
      dbMocks.getSongSections.mockResolvedValueOnce([
        makeSection({ position: 1, kind: 'verse', lyrics: 'chickpeas in the moonlight' }),
      ]);

      const result = await handleLyricsCommand('show Sundown');

      expect(dbMocks.getSongByTitle).toHaveBeenCalledWith('Sundown');
      expect(result).toContain('Sundown');
      expect(result).toContain('chickpeas in the moonlight');
    });

    it('returns a not-found message for an unknown song', async () => {
      dbMocks.getSongByTitle.mockResolvedValueOnce(undefined);

      const result = await handleLyricsCommand('show Nonexistent');

      expect(dbMocks.getSongSections).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no song/i);
    });
  });

  describe('set', () => {
    it('adds a lyrics section for the given kind', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);
      dbMocks.addSongSection.mockResolvedValueOnce(
        makeSection({ id: 20, songId: 1, kind: 'verse', position: 3, lyrics: 'blue skies over garbanzo' }),
      );

      const result = await handleLyricsCommand('set Sundown verse blue skies over garbanzo');

      expect(dbMocks.addSongSection).toHaveBeenCalledWith({
        songId: 1,
        kind: 'verse',
        lyrics: 'blue skies over garbanzo',
      });
      expect(result).toMatch(/added/i);
      expect(result).toContain('Sundown');
    });

    it('resolves a multi-word song title', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 2, title: 'Chickpea Boogie' })]);
      dbMocks.addSongSection.mockResolvedValueOnce(
        makeSection({ id: 21, songId: 2, kind: 'chorus', position: 1, lyrics: 'boogie all night' }),
      );

      const result = await handleLyricsCommand('set Chickpea Boogie chorus boogie all night');

      expect(dbMocks.addSongSection).toHaveBeenCalledWith({
        songId: 2,
        kind: 'chorus',
        lyrics: 'boogie all night',
      });
      expect(result).toMatch(/added/i);
    });

    it('rejects an invalid kind without calling addSongSection', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);

      const result = await handleLyricsCommand('set Sundown notarealkind some lyrics');

      expect(dbMocks.addSongSection).not.toHaveBeenCalled();
      expect(result).toMatch(/kind/i);
    });

    it('returns a not-found message for an unknown song', async () => {
      dbMocks.listSongs.mockResolvedValueOnce([makeSong({ id: 1, title: 'Sundown' })]);

      const result = await handleLyricsCommand('set Nonexistent verse some lyrics');

      expect(dbMocks.addSongSection).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no song/i);
    });
  });

  describe('unknown/empty subcommand', () => {
    it('returns a usage string for an unknown subcommand', async () => {
      const result = await handleLyricsCommand('frobnicate Sundown');
      expect(result).toMatch(/usage|commands/i);
    });

    it('returns a usage string for empty args', async () => {
      const result = await handleLyricsCommand('');
      expect(result).toMatch(/usage|commands/i);
    });
  });
});
