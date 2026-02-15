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

describe('Mention detection', async () => {
  const { isMentioned, stripMention } = await import('../src/platforms/whatsapp/mentions.js');

  it('detects text-based @garbanzo mention', () => {
    expect(isMentioned('hey @garbanzo what is the weather')).toBe(true);
  });

  it('detects text-based mention case-insensitively', () => {
    expect(isMentioned('Hey @Garbanzo Bean tell me something')).toBe(true);
  });

  it('rejects messages without mention', () => {
    expect(isMentioned('just a regular message')).toBe(false);
  });

  it('detects JID-based native WhatsApp mention', () => {
    const mentionedJids = ['15551234567@s.whatsapp.net'];
    const botJid = '15551234567:42@s.whatsapp.net'; // Baileys often adds :deviceId
    expect(isMentioned('@15551234567 hello', mentionedJids, botJid)).toBe(true);
  });

  it('rejects JID mention when bot JID does not match', () => {
    const mentionedJids = ['15559999999@s.whatsapp.net'];
    const botJid = '15551234567@s.whatsapp.net';
    expect(isMentioned('hello', mentionedJids, botJid)).toBe(false);
  });

  it('detects LID-based native WhatsApp mention', () => {
    const mentionedJids = ['11395269660682@lid'];
    const botJid = '18574988758:1@s.whatsapp.net';
    const botLid = '11395269660682:1@lid';
    expect(isMentioned('@11395269660682 hello', mentionedJids, botJid, botLid)).toBe(true);
  });

  it('detects LID mention even when botJid does not match', () => {
    // Phone JID and LID are completely different identifiers
    const mentionedJids = ['11395269660682@lid'];
    const botJid = '18574988758:1@s.whatsapp.net';
    const botLid = '11395269660682:1@lid';
    expect(isMentioned('hello', mentionedJids, botJid, botLid)).toBe(true);
  });

  it('strips text-based mention from message', () => {
    expect(stripMention('  @garbanzo what is the weather  ')).toBe('what is the weather');
  });

  it('strips native phone-number mention from message', () => {
    const botJid = '15551234567:42@s.whatsapp.net';
    expect(stripMention('@15551234567 what is the weather', botJid)).toBe('what is the weather');
  });

  it('strips LID-based mention from message', () => {
    const botJid = '18574988758:1@s.whatsapp.net';
    const botLid = '11395269660682:1@lid';
    expect(stripMention('@11395269660682 trying another', botJid, botLid)).toBe('trying another');
  });
});
