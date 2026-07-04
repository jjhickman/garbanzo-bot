process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rehearsal, Setlist, SetlistEntry, Song } from '../src/utils/db-types.js';

// Practice agenda must consume ONLY the db barrel (plus pure format helpers) —
// never the AI layer. `buildWeeklyRecap` is deliberately LLM-free for the
// same reason (survives all AI providers down); this mirrors that pattern.
const dbMocks = vi.hoisted(() => ({
  // used directly by practice-agenda.ts
  getNextRehearsal: vi.fn(),
  listSongs: vi.fn(),
  listSetlists: vi.fn(),
  getSetlistSongs: vi.fn(),
  // pulled in transitively via formatRehearsalLine/formatSongLine/formatSetlist
  // (rehearsals.js / songs.js / setlists.js each import several db functions
  // that are unused by this test but must exist as named exports)
  addRehearsal: vi.fn(),
  cancelRehearsal: vi.fn(),
  getRehearsalById: vi.fn(),
  listAvailability: vi.fn(),
  listUpcomingRehearsals: vi.fn(),
  setAvailability: vi.fn(),
  updateRehearsal: vi.fn(),
  addSong: vi.fn(),
  deleteSong: vi.fn(),
  getSongByTitle: vi.fn(),
  updateSong: vi.fn(),
  addSetlist: vi.fn(),
  addSongToSetlist: vi.fn(),
  deleteSetlist: vi.fn(),
  getSetlistByName: vi.fn(),
  moveSetlistSong: vi.fn(),
  removeSongFromSetlist: vi.fn(),
}));

vi.mock('../src/utils/db.js', () => dbMocks);

import { buildPracticeAgenda, handleAgendaCommand } from '../src/features/practice-agenda.js';

function makeSong(overrides: Partial<Song> = {}): Song {
  return {
    id: 1,
    title: 'Sundown',
    key: 'E',
    tempo: 120,
    status: 'rough',
    notes: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeRehearsal(overrides: Partial<Rehearsal> = {}): Rehearsal {
  return {
    id: 7,
    scheduledAt: Math.floor(new Date('2026-07-10T19:00:00').getTime() / 1000),
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

function makeSetlist(overrides: Partial<Setlist> = {}): Setlist {
  return {
    id: 3,
    name: 'Summer Gig',
    notes: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('buildPracticeAgenda', () => {
  beforeEach(() => {
    dbMocks.getNextRehearsal.mockReset().mockResolvedValue(undefined);
    dbMocks.listSongs.mockReset().mockResolvedValue([]);
    dbMocks.listSetlists.mockReset().mockResolvedValue([]);
    dbMocks.getSetlistSongs.mockReset().mockResolvedValue([]);
  });

  it('is LLM-free — the module source never touches the AI layer', () => {
    const modulePath = fileURLToPath(new URL('../src/features/practice-agenda.ts', import.meta.url));
    const source = readFileSync(modulePath, 'utf8');

    expect(source).not.toMatch(/getResponse/);
    expect(source).not.toMatch(/from ['"]\.\.\/ai\//);
    expect(source).not.toMatch(/callClaude|callChatGPT|callGemini|callBedrock|callOllama/);
  });

  it('renders next rehearsal, needs-work songs, and the setlist to run', async () => {
    const rehearsal = makeRehearsal();
    dbMocks.getNextRehearsal.mockResolvedValue(rehearsal);

    const roughSong = makeSong({ id: 1, title: 'Sundown', status: 'rough' });
    const ideaSong = makeSong({ id: 2, title: 'Chickpea Boogie', key: null, tempo: null, status: 'idea' });
    dbMocks.listSongs.mockImplementation(async (status?: string) => {
      if (status === 'rough') return [roughSong];
      if (status === 'idea') return [ideaSong];
      return [];
    });

    const setlist = makeSetlist();
    dbMocks.listSetlists.mockResolvedValue([setlist]);
    const entries: SetlistEntry[] = [{ position: 1, song: roughSong }];
    dbMocks.getSetlistSongs.mockResolvedValue(entries);

    const result = await buildPracticeAgenda(new Date('2026-07-03T12:00:00'));

    expect(result).toContain('Next rehearsal: #7 · Fri Jul 10 7:00pm · The Garage · scheduled');
    expect(result).toContain('Needs work:');
    expect(result).toContain('Sundown (E, 120bpm, rough)');
    expect(result).toContain('Chickpea Boogie (idea)');
    expect(result).toContain('Set to run:');
    expect(result).toContain('Summer Gig');
    expect(dbMocks.getSetlistSongs).toHaveBeenCalledWith(setlist.id);

    // "Needs work" must list rough songs before idea songs.
    expect(result.indexOf('Sundown')).toBeLessThan(result.indexOf('Chickpea Boogie'));
  });

  it('says "none scheduled" when there is no next rehearsal', async () => {
    dbMocks.getNextRehearsal.mockResolvedValue(undefined);
    dbMocks.listSongs.mockResolvedValue([]);
    dbMocks.listSetlists.mockResolvedValue([{ ...makeSetlist() }]);

    const result = await buildPracticeAgenda(new Date('2026-07-03T12:00:00'));

    expect(result).toContain('Next rehearsal: none scheduled');
  });

  it('caps needs-work songs and adds an "…and N more" tail', async () => {
    dbMocks.getNextRehearsal.mockResolvedValue(makeRehearsal());
    const roughSongs = Array.from({ length: 10 }, (_, i) =>
      makeSong({ id: i + 1, title: `Rough ${i + 1}`, status: 'rough' }));
    const ideaSongs = Array.from({ length: 6 }, (_, i) =>
      makeSong({ id: i + 100, title: `Idea ${i + 1}`, status: 'idea' }));
    dbMocks.listSongs.mockImplementation(async (status?: string) => {
      if (status === 'rough') return roughSongs;
      if (status === 'idea') return ideaSongs;
      return [];
    });

    const result = await buildPracticeAgenda(new Date('2026-07-03T12:00:00'));

    // 10 rough + 6 idea = 16 total, capped at 15 (all 10 rough + first 5 idea),
    // so exactly 1 remains.
    expect(result).toContain('Rough 1');
    expect(result).toContain('Rough 10');
    expect(result).toContain('Idea 1');
    expect(result).toContain('Idea 5');
    expect(result).not.toContain('Idea 6');
    expect(result).toContain('…and 1 more');
  });

  it('omits the "Needs work" section when there are no rough/idea songs', async () => {
    dbMocks.getNextRehearsal.mockResolvedValue(makeRehearsal());
    dbMocks.listSongs.mockResolvedValue([]);
    dbMocks.listSetlists.mockResolvedValue([]);

    const result = await buildPracticeAgenda(new Date('2026-07-03T12:00:00'));

    expect(result).not.toContain('Needs work');
    expect(result).not.toContain('Set to run');
  });

  it('omits the "Set to run" section when there are no setlists', async () => {
    dbMocks.getNextRehearsal.mockResolvedValue(makeRehearsal());
    dbMocks.listSongs.mockImplementation(async (status?: string) =>
      (status === 'rough' ? [makeSong({ status: 'rough' })] : []));
    dbMocks.listSetlists.mockResolvedValue([]);

    const result = await buildPracticeAgenda(new Date('2026-07-03T12:00:00'));

    expect(result).toContain('Needs work:');
    expect(result).not.toContain('Set to run');
    expect(dbMocks.getSetlistSongs).not.toHaveBeenCalled();
  });

  it('returns a single friendly line when there is nothing at all', async () => {
    dbMocks.getNextRehearsal.mockResolvedValue(undefined);
    dbMocks.listSongs.mockResolvedValue([]);
    dbMocks.listSetlists.mockResolvedValue([]);

    const result = await buildPracticeAgenda(new Date('2026-07-03T12:00:00'));

    expect(result).toBe('No practice items yet — add songs with !song and schedule with !rehearsal.');
  });
});

describe('handleAgendaCommand', () => {
  beforeEach(() => {
    dbMocks.getNextRehearsal.mockReset().mockResolvedValue(undefined);
    dbMocks.listSongs.mockReset().mockResolvedValue([]);
    dbMocks.listSetlists.mockReset().mockResolvedValue([]);
    dbMocks.getSetlistSongs.mockReset().mockResolvedValue([]);
  });

  it('delegates to buildPracticeAgenda', async () => {
    const result = await handleAgendaCommand();
    expect(result).toBe('No practice items yet — add songs with !song and schedule with !rehearsal.');
  });
});
