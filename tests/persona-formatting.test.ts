process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it } from 'vitest';
import { buildFormattingInstruction } from '../src/ai/persona.js';

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
