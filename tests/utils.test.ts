import { describe, it, expect } from 'vitest';

// These tests validate the utility modules without requiring
// WhatsApp connection or API keys.

// mentions.js transitively loads config, which validates required env.
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

describe('JID utilities', async () => {
  const { isGroupJid, isDmJid, isLidJid, phoneFromJid, phoneToJid, bareUserJid, jidsMatch } = await import('../src/utils/jid.js');

  it('identifies group JIDs', () => {
    expect(isGroupJid('120363423357339667@g.us')).toBe(true);
    expect(isGroupJid('15551234567@s.whatsapp.net')).toBe(false);
  });

  it('identifies DM JIDs', () => {
    expect(isDmJid('15551234567@s.whatsapp.net')).toBe(true);
    expect(isDmJid('120363423357339667@g.us')).toBe(false);
  });

  it('extracts phone from JID', () => {
    expect(phoneFromJid('15551234567@s.whatsapp.net')).toBe('15551234567');
  });

  it('converts phone to JID', () => {
    expect(phoneToJid('+1-555-123-4567')).toBe('15551234567@s.whatsapp.net');
  });

  it('identifies LID JIDs', () => {
    expect(isLidJid('184468458393129@lid')).toBe(true);
    expect(isLidJid('15551234567@s.whatsapp.net')).toBe(false);
  });

  it('strips device suffixes from user JIDs', () => {
    expect(bareUserJid('15551234567:17@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
    expect(bareUserJid('15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
    expect(bareUserJid('U0123ABCD')).toBe('U0123ABCD'); // non-JID platform IDs untouched
  });

  it('matches JIDs across device suffixes', () => {
    expect(jidsMatch('15551234567:17@s.whatsapp.net', '15551234567@s.whatsapp.net')).toBe(true);
    expect(jidsMatch('15551234567@s.whatsapp.net', '15559999999@s.whatsapp.net')).toBe(false);
    expect(jidsMatch('184468458393129@lid', '15551234567@s.whatsapp.net')).toBe(false);
    expect(jidsMatch('U0123ABCD', 'U0123ABCD')).toBe(true); // non-JID plain equality
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
