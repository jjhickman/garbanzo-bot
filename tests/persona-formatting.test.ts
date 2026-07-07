process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDistilledIdentityBlock, buildFormattingInstruction, getPersonaName } from '../src/ai/persona.js';

describe('buildFormattingInstruction', () => {
  it('uses Discord markdown for discord', () => {
    const s = buildFormattingInstruction('discord');
    expect(s).toMatch(/\*\*bold\*\*/);
    expect(s).toMatch(/~~strike~~/);
    expect(s).not.toMatch(/~strike~[^~]/);
  });

  it('uses WhatsApp markup for whatsapp', () => {
    const s = buildFormattingInstruction('whatsapp');
    expect(s).toMatch(/\*bold\*/);
    expect(s).toMatch(/_italic_/);
  });
});

describe('buildDistilledIdentityBlock', () => {
  it('uses the loaded persona name for discord without meetup references', () => {
    const s = buildDistilledIdentityBlock('discord');
    expect(s).toContain(`You are ${getPersonaName()}, a warm, direct assistant for a band's Discord.`);
    expect(s).toContain("band's Discord");
    expect(s).toContain('practice, writing music, and coordinating');
    expect(s).not.toContain('Boston');
    expect(s).not.toContain('meetup');
  });

  it('uses the Garbanzo Bean Boston identity for whatsapp', () => {
    const s = buildDistilledIdentityBlock('whatsapp');
    expect(s).toContain('You are Garbanzo Bean 🫘, a WhatsApp community bot for a 120-member Boston-area meetup group (ages 25-45).');
    expect(s).toContain('Knowledgeable about Boston');
  });
});

describe('buildSystemPrompt memory formatting', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../src/utils/config.js');
    vi.doUnmock('../src/middleware/logger.js');
    vi.doUnmock('../src/middleware/context.js');
    vi.doUnmock('../src/features/language.js');
    vi.doUnmock('../src/features/introductions.js');
    vi.doUnmock('../src/features/web-search.js');
    vi.doUnmock('../src/core/groups-config.js');
    vi.doUnmock('../src/utils/db.js');
    vi.doUnmock('../src/features/band-knowledge.js');
    vi.doUnmock('fs');
    vi.restoreAllMocks();
  });

  it('uses shared-aware memory formatting with the user message', async () => {
    vi.resetModules();
    const formatMemoriesForPromptWithShared = vi.fn(async () =>
      'Community knowledge (facts you know about this group):\n  general:\n    - [shared from discord] Practice starts at 7',
    );

    vi.doMock('../src/utils/config.js', () => ({
      config: {
        MESSAGING_PLATFORM: 'whatsapp',
        AI_TOOL_CALLING: false,
      },
    }));
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    }));
    vi.doMock('../src/middleware/context.js', () => ({
      formatContext: vi.fn(async () => ''),
    }));
    vi.doMock('../src/features/language.js', () => ({
      buildLanguageInstruction: vi.fn(() => ''),
    }));
    vi.doMock('../src/features/introductions.js', () => ({
      INTRO_SYSTEM_ADDENDUM: '',
    }));
    vi.doMock('../src/features/web-search.js', () => ({
      getSearchProviderName: vi.fn(() => null),
    }));
    vi.doMock('../src/core/groups-config.js', () => ({
      getGroupPersona: vi.fn(() => undefined),
      getEnabledGroupJidByName: vi.fn(() => null),
    }));
    vi.doMock('../src/utils/db.js', () => ({
      formatMemoriesForPromptWithShared,
    }));
    vi.doMock('../src/features/band-knowledge.js', () => ({
      formatBandKnowledgeForPrompt: vi.fn(async () => ''),
    }));
    vi.doMock('fs', () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => '# Garbanzo Bean\n\nPersona.'),
    }));

    const { buildSystemPrompt } = await import('../src/ai/persona.js');
    const prompt = await buildSystemPrompt(
      {
        groupName: 'Practice',
        groupJid: 'practice-chat',
        senderJid: 'sender',
      },
      'When is practice?',
    );

    expect(formatMemoriesForPromptWithShared).toHaveBeenCalledWith('When is practice?');
    expect(prompt).toContain('[shared from discord] Practice starts at 7');
  });
});
