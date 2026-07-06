process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../src/utils/db-types.js';

const configMock = vi.hoisted(() => ({
  MESSAGING_PLATFORM: 'discord',
  AI_TOOL_CALLING: false,
  BAND_FEATURES_ENABLED: true,
}));

const dbMocks = vi.hoisted(() => ({
  addSong: vi.fn(),
  getSongById: vi.fn(),
  getSongByTitle: vi.fn(),
  listSongs: vi.fn(),
  updateSong: vi.fn(),
  deleteSong: vi.fn(),
  formatMemoriesForPrompt: vi.fn(),
  formatMemoriesForPromptWithShared: vi.fn(),
}));

vi.mock('../src/utils/config.js', () => ({
  PROJECT_ROOT: '/tmp',
  config: configMock,
}));

vi.mock('../src/middleware/logger.js', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

vi.mock('../src/middleware/context.js', () => ({
  formatContext: vi.fn(async () => ''),
}));

vi.mock('../src/features/language.js', () => ({
  buildLanguageInstruction: vi.fn(() => ''),
}));

vi.mock('../src/features/introductions.js', () => ({
  INTRO_SYSTEM_ADDENDUM: 'INTRO ADDENDUM',
}));

vi.mock('../src/features/web-search.js', () => ({
  getSearchProviderName: vi.fn(() => null),
}));

vi.mock('../src/core/groups-config.js', () => ({
  getGroupPersona: vi.fn(() => null),
  getEnabledGroupJidByName: vi.fn(() => null),
}));

vi.mock('../src/utils/db.js', () => dbMocks);

import { buildOllamaPrompt, buildSystemPrompt } from '../src/ai/persona.js';

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

const ctx = {
  groupName: 'Band Practice',
  groupJid: 'band-discord-channel',
  senderJid: '111',
};

describe('persona band knowledge prompt injection', () => {
  beforeEach(() => {
    configMock.BAND_FEATURES_ENABLED = true;
    dbMocks.listSongs.mockReset();
    dbMocks.formatMemoriesForPrompt.mockReset();
    dbMocks.formatMemoriesForPrompt.mockResolvedValue('');
    dbMocks.formatMemoriesForPromptWithShared.mockReset();
    dbMocks.formatMemoriesForPromptWithShared.mockResolvedValue('');
  });

  afterEach(() => {
    configMock.BAND_FEATURES_ENABLED = true;
  });

  it('includes the band knowledge block in buildSystemPrompt when enabled and songs exist', async () => {
    dbMocks.listSongs.mockResolvedValueOnce([
      makeSong({ title: 'Sundown' }),
      makeSong({ id: 2, title: 'Chickpea Boogie', key: null, tempo: null, status: 'idea' }),
    ]);

    const prompt = await buildSystemPrompt(ctx);

    expect(prompt).toContain('Band songs you know:');
    expect(prompt).toContain('- Sundown (E, 120bpm, gig-ready)');
    expect(prompt).toContain('- Chickpea Boogie (idea)');
  });

  it('omits the band knowledge block in buildSystemPrompt when disabled', async () => {
    configMock.BAND_FEATURES_ENABLED = false;
    dbMocks.listSongs.mockResolvedValueOnce([
      makeSong({ title: 'Sundown' }),
    ]);

    const prompt = await buildSystemPrompt(ctx);

    expect(prompt).not.toContain('Band songs you know:');
    expect(prompt).not.toContain('Sundown (E, 120bpm, gig-ready)');
    expect(dbMocks.listSongs).not.toHaveBeenCalled();
  });

  it('includes the band knowledge block in buildOllamaPrompt when enabled and songs exist', async () => {
    dbMocks.listSongs.mockResolvedValueOnce([
      makeSong({ title: 'Sundown' }),
    ]);

    const prompt = await buildOllamaPrompt(ctx);

    expect(prompt).toContain('Band songs you know:');
    expect(prompt).toContain('- Sundown (E, 120bpm, gig-ready)');
  });
});
