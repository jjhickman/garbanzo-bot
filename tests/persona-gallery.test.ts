process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { readFileSync as realReadFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// WS10: every shipped gallery persona must parse to the exact name + emoji
// its wizard picker entry (scripts/setup-fields... PERSONA_GALLERY in
// scripts/setup.mjs) promises, using the SAME derivation the runtime uses
// (src/ai/persona.ts's getPersonaName()/getPersonaEmoji(), exercised the
// same way tests/persona-name.test.ts does — by mocking `fs` so the module
// "loads" each gallery file's real content without touching the real
// GARBANZO_HOME/asset resolution).
const GALLERY_DIR = resolve(process.cwd(), 'docs', 'personas', 'gallery');

const GALLERY = [
  { file: 'riff.md', name: 'Riff', emoji: '🎸' },
  { file: 'quill.md', name: 'Quill', emoji: '🎲' },
  { file: 'margie.md', name: 'Margie', emoji: '📚' },
  { file: 'bea.md', name: 'Bea', emoji: '🏡' },
  { file: 'patch.md', name: 'Patch', emoji: '🔧' },
  { file: 'callie.md', name: 'Callie', emoji: '🎭' },
];

async function loadPersonaModuleWithDoc(doc: string): Promise<typeof import('../src/ai/persona.js')> {
  vi.resetModules();

  vi.doMock('../src/middleware/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  }));
  vi.doMock('../src/utils/config.js', () => ({
    config: { MESSAGING_PLATFORM: 'discord', AI_TOOL_CALLING: false },
  }));
  vi.doMock('../src/utils/paths.js', () => ({
    homePath: (...segments: string[]) => ['/repo', ...segments].join('/'),
    assetPath: (...segments: string[]) => ['/repo', ...segments].join('/'),
  }));
  vi.doMock('../src/features/introductions.js', () => ({ INTRO_SYSTEM_ADDENDUM: '' }));
  vi.doMock('../src/core/groups-config.js', () => ({
    getEnabledGroupJidByName: vi.fn(() => null),
    getGroupPersona: vi.fn(() => undefined),
  }));
  vi.doMock('../src/middleware/context.js', () => ({ formatContext: vi.fn(async () => '') }));
  vi.doMock('../src/features/language.js', () => ({ buildLanguageInstruction: vi.fn(() => '') }));
  vi.doMock('../src/utils/db.js', () => ({ formatMemoriesForPrompt: vi.fn(async () => '') }));
  vi.doMock('../src/features/web-search.js', () => ({ getSearchProviderName: vi.fn(() => null) }));
  vi.doMock('../src/features/band-knowledge.js', () => ({ formatBandKnowledgeForPrompt: vi.fn(async () => '') }));

  vi.doMock('fs', () => ({
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn((): string => doc),
  }));

  return import('../src/ai/persona.js');
}

describe('persona gallery', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('fs');
    vi.doUnmock('../src/middleware/logger.js');
    vi.doUnmock('../src/utils/config.js');
    vi.doUnmock('../src/utils/paths.js');
    vi.doUnmock('../src/features/introductions.js');
    vi.doUnmock('../src/core/groups-config.js');
    vi.doUnmock('../src/middleware/context.js');
    vi.doUnmock('../src/features/language.js');
    vi.doUnmock('../src/utils/db.js');
    vi.doUnmock('../src/features/web-search.js');
    vi.doUnmock('../src/features/band-knowledge.js');
    vi.restoreAllMocks();
  });

  for (const entry of GALLERY) {
    it(`${entry.file} parses to name "${entry.name}" and emoji "${entry.emoji}"`, async () => {
      const doc = realReadFileSync(resolve(GALLERY_DIR, entry.file), 'utf-8');
      const module = await loadPersonaModuleWithDoc(doc);

      expect(module.getPersonaName()).toBe(entry.name);
      expect(module.getPersonaEmoji()).toBe(entry.emoji);
    });
  }

  it('every gallery file starts with a starting-point HTML comment naming its target use case', () => {
    for (const entry of GALLERY) {
      const doc = realReadFileSync(resolve(GALLERY_DIR, entry.file), 'utf-8');
      expect(doc.trimStart().startsWith('<!--')).toBe(true);
      expect(doc).toMatch(/starting point/i);
    }
  });

  it('gallery filenames never collide with a platform-key persona filename', () => {
    // docs/personas/*.md filenames are platform keys the loader resolves by
    // MESSAGING_PLATFORM (docs/personas/discord.md, etc) — gallery names
    // living in docs/personas/gallery/ must never collide with one, or a
    // gallery pick could be mistaken for a shipped platform default.
    const platformKeys = ['whatsapp', 'discord', 'slack', 'telegram', 'matrix'];
    for (const entry of GALLERY) {
      const key = entry.file.replace(/\.md$/, '');
      expect(platformKeys).not.toContain(key);
    }
  });
});
