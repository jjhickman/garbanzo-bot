process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, describe, expect, it, vi } from 'vitest';

type MessagingPlatform = 'whatsapp' | 'discord' | 'slack' | 'teams';

interface LoadPersonaOptions {
  doc?: string;
  exists?: boolean;
  platform?: MessagingPlatform;
  readThrows?: boolean;
}

async function loadPersonaModule(options: LoadPersonaOptions = {}): Promise<{
  module: typeof import('../src/ai/persona.js');
  loggerInfo: ReturnType<typeof vi.fn>;
  loggerWarn: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();

  const loggerInfo = vi.fn();
  const loggerWarn = vi.fn();

  vi.doMock('../src/middleware/logger.js', () => ({
    logger: {
      info: loggerInfo,
      warn: loggerWarn,
      error: vi.fn(),
      fatal: vi.fn(),
    },
  }));

  vi.doMock('../src/utils/config.js', () => ({
    config: {
      MESSAGING_PLATFORM: options.platform ?? 'whatsapp',
      AI_TOOL_CALLING: false,
    },
  }));

  vi.doMock('../src/utils/paths.js', () => ({
    homePath: (...segments: string[]) => ['/repo', ...segments].join('/'),
    assetPath: (...segments: string[]) => ['/repo', ...segments].join('/'),
  }));

  vi.doMock('../src/features/introductions.js', () => ({
    INTRO_SYSTEM_ADDENDUM: '',
  }));
  vi.doMock('../src/core/groups-config.js', () => ({
    getEnabledGroupJidByName: vi.fn(() => null),
    getGroupPersona: vi.fn(() => undefined),
  }));
  vi.doMock('../src/middleware/context.js', () => ({
    formatContext: vi.fn(async () => ''),
  }));
  vi.doMock('../src/features/language.js', () => ({
    buildLanguageInstruction: vi.fn(() => ''),
  }));
  vi.doMock('../src/utils/db.js', () => ({
    formatMemoriesForPrompt: vi.fn(async () => ''),
  }));
  vi.doMock('../src/features/web-search.js', () => ({
    getSearchProviderName: vi.fn(() => null),
  }));
  vi.doMock('../src/features/band-knowledge.js', () => ({
    formatBandKnowledgeForPrompt: vi.fn(async () => ''),
  }));

  vi.doMock('fs', () => ({
    existsSync: vi.fn(() => options.exists ?? true),
    readFileSync: vi.fn((path: string): string => {
      if (options.readThrows) throw new Error(`missing ${path}`);
      return options.doc ?? '# Garbanzo Bean 🫘 — Persona Document\n';
    }),
  }));

  return {
    module: await import('../src/ai/persona.js'),
    loggerInfo,
    loggerWarn,
  };
}

describe('getPersonaName', () => {
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

  it('derives a Remy-style heading from the loaded persona document', async () => {
    const { module } = await loadPersonaModule({
      doc: '# Remy - Persona Document\n\nBand assistant.',
      platform: 'discord',
    });

    expect(module.getPersonaName()).toBe('Remy');
  });

  it('strips trailing emoji from a Garbanzo Bean heading', async () => {
    const { module } = await loadPersonaModule({
      doc: '# Garbanzo Bean 🫘\n\nCommunity assistant.',
    });

    expect(module.getPersonaName()).toBe('Garbanzo Bean');
  });

  it('falls back when the loaded persona document has no heading', async () => {
    const { module } = await loadPersonaModule({
      doc: 'You are a community assistant without a markdown heading.',
    });

    expect(module.getPersonaName()).toBe('Garbanzo Bean');
  });

  it('falls back when the persona document cannot be read', async () => {
    const { module, loggerWarn } = await loadPersonaModule({
      exists: false,
      readThrows: true,
    });

    expect(module.getPersonaName()).toBe('Garbanzo Bean');
    expect(loggerWarn).toHaveBeenCalledWith('PERSONA.md not found — using minimal system prompt');
  });

  it('uses the derived name in the Discord distilled identity', async () => {
    const { module } = await loadPersonaModule({
      doc: '# Ada — persona\n\nBand assistant.',
      platform: 'discord',
    });

    const identity = module.buildDistilledIdentityBlock('discord');
    expect(identity).toContain("You are Ada, a warm, direct assistant for a band's Discord.");
    expect(identity).not.toContain('You are Remy');
  });

  it('uses the derived name in the WhatsApp distilled identity', async () => {
    const { module } = await loadPersonaModule({
      doc: '# Ada — persona\n\nCommunity assistant.',
      platform: 'whatsapp',
    });

    const identity = module.buildDistilledIdentityBlock('whatsapp');
    expect(identity).toContain('You are Ada 🫘, a WhatsApp community bot');
    expect(identity).not.toContain('You are Garbanzo Bean');
  });

  it('logs the loaded persona name once after reading the persona file', async () => {
    const { loggerInfo } = await loadPersonaModule({
      doc: '# Remy - Persona Document\n',
      platform: 'discord',
    });

    expect(loggerInfo).toHaveBeenCalledWith(
      {
        personaFile: '/repo/docs/personas/discord.md',
        platform: 'discord',
        personaName: 'Remy',
      },
      'Persona loaded',
    );
  });
});
