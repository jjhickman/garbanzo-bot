import { describe, it, expect } from 'vitest';

// These tests validate the utility modules without requiring
// WhatsApp connection or API keys.

describe('JID utilities', async () => {
  const { isGroupJid, isDmJid, phoneFromJid, phoneToJid } = await import('../src/utils/jid.js');

  it('identifies group JIDs', () => {
    expect(isGroupJid('120363423357339667@g.us')).toBe(true);
    expect(isGroupJid('17819754407@s.whatsapp.net')).toBe(false);
  });

  it('identifies DM JIDs', () => {
    expect(isDmJid('17819754407@s.whatsapp.net')).toBe(true);
    expect(isDmJid('120363423357339667@g.us')).toBe(false);
  });

  it('extracts phone from JID', () => {
    expect(phoneFromJid('17819754407@s.whatsapp.net')).toBe('17819754407');
  });

  it('converts phone to JID', () => {
    expect(phoneToJid('+1-781-975-4407')).toBe('17819754407@s.whatsapp.net');
  });
});

describe('Formatting utilities', async () => {
  const { bold, italic, truncate } = await import('../src/utils/formatting.js');

  it('formats bold text', () => {
    expect(bold('hello')).toBe('*hello*');
  });

  it('formats italic text', () => {
    expect(italic('hello')).toBe('_hello_');
  });

  it('truncates long text', () => {
    const long = 'a'.repeat(5000);
    const result = truncate(long, 100);
    expect(result.length).toBe(100);
    expect(result.endsWith('...')).toBe(true);
  });

  it('does not truncate short text', () => {
    expect(truncate('hello', 100)).toBe('hello');
  });
});
