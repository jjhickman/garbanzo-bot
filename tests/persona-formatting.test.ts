process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it } from 'vitest';
import { buildDistilledIdentityBlock, buildFormattingInstruction } from '../src/ai/persona.js';

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
  it('uses Remy identity for discord without Garbanzo meetup references', () => {
    const s = buildDistilledIdentityBlock('discord');
    expect(s).toContain('Remy');
    expect(s).toContain("band's Discord");
    expect(s).toContain('practice, writing music, and coordinating');
    expect(s).not.toContain('Garbanzo Bean');
    expect(s).not.toContain('Boston');
    expect(s).not.toContain('meetup');
  });

  it('uses the Garbanzo Bean Boston identity for whatsapp', () => {
    const s = buildDistilledIdentityBlock('whatsapp');
    expect(s).toContain('You are Garbanzo Bean 🫘, a WhatsApp community bot for a 120-member Boston-area meetup group (ages 25-45).');
    expect(s).toContain('Knowledgeable about Boston');
  });
});
