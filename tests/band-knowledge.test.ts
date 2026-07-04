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

import { formatBandKnowledgeForPrompt } from '../src/features/band-knowledge.js';
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

describe('formatBandKnowledgeForPrompt', () => {
  let originalBandFeaturesEnabled: boolean;

  beforeEach(() => {
    originalBandFeaturesEnabled = config.BAND_FEATURES_ENABLED;
    config.BAND_FEATURES_ENABLED = true;
    dbMocks.listSongs.mockReset();
  });

  afterEach(() => {
    config.BAND_FEATURES_ENABLED = originalBandFeaturesEnabled;
  });

  it('renders a compact catalog block for known songs', async () => {
    dbMocks.listSongs.mockResolvedValueOnce([
      makeSong({ id: 1, title: 'Sundown', key: 'E', tempo: 120, status: 'gig-ready' }),
      makeSong({ id: 2, title: 'Chickpea Boogie', key: null, tempo: null, status: 'idea' }),
      makeSong({ id: 3, title: 'Late Train', key: 'A', tempo: null, status: 'rough' }),
    ]);

    await expect(formatBandKnowledgeForPrompt()).resolves.toBe([
      'Band songs you know:',
      '- Sundown (E, 120bpm, gig-ready)',
      '- Chickpea Boogie (idea)',
      '- Late Train (A, rough)',
    ].join('\n'));
    expect(dbMocks.listSongs).toHaveBeenCalledWith();
  });

  it('returns an empty string when band features are disabled', async () => {
    config.BAND_FEATURES_ENABLED = false;

    await expect(formatBandKnowledgeForPrompt()).resolves.toBe('');
    expect(dbMocks.listSongs).not.toHaveBeenCalled();
  });

  it('returns an empty string when there are no songs', async () => {
    dbMocks.listSongs.mockResolvedValueOnce([]);

    await expect(formatBandKnowledgeForPrompt()).resolves.toBe('');
  });

  it('caps the catalog at 40 songs and reports the remainder', async () => {
    dbMocks.listSongs.mockResolvedValueOnce(
      Array.from({ length: 43 }, (_, index) => makeSong({
        id: index + 1,
        title: `Song ${index + 1}`,
      })),
    );

    const result = await formatBandKnowledgeForPrompt();

    expect(result).toContain('- Song 1 (E, 120bpm, gig-ready)');
    expect(result).toContain('- Song 40 (E, 120bpm, gig-ready)');
    expect(result).not.toContain('- Song 41 (E, 120bpm, gig-ready)');
    expect(result).toContain('…and 3 more');
    expect(result.split('\n')).toHaveLength(42);
  });
});
