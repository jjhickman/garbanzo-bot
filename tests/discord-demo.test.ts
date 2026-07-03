import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/platforms/discord/discord-config.js', () => ({
  isDiscordChannelEnabled: vi.fn((channelId: string) => channelId === 'C123'),
  discordChannelRequiresMention: vi.fn(() => true),
  isDiscordFeatureEnabled: vi.fn(() => true),
  getDiscordChannelName: vi.fn(() => 'general'),
  getDiscordIntroductionsChannelId: vi.fn(() => null),
  getDiscordEventsChannelId: vi.fn(() => null),
}));

import { createDiscordDemoAdapter } from '../src/platforms/discord/adapter.js';
import { normalizeDiscordDemoInbound, processDiscordDemoInbound } from '../src/platforms/discord/processor.js';

describe('Discord demo runtime', () => {
  it('routes !help through the core pipeline', async () => {
    const outbox: Array<{ type: string; chatId: string; payload: unknown }> = [];
    const messenger = createDiscordDemoAdapter(outbox);

    const inbound = normalizeDiscordDemoInbound({
      chatId: 'C123',
      senderId: 'U123',
      text: '!help',
      isGroupChat: true,
    });

    await processDiscordDemoInbound(messenger, inbound, { ownerId: 'owner@s.whatsapp.net' });

    expect(outbox.length).toBeGreaterThan(0);
    const first = outbox[0];
    expect(first.type).toBe('text');

    const payload = first.payload as { text?: unknown; replyToId?: unknown; threadId?: unknown };
    expect(typeof payload.text).toBe('string');
    expect(String(payload.text)).toContain('Garbanzo Bean');
    expect(payload.replyToId).toBe(inbound.raw.id);
    expect(payload.threadId).toBe(null);
  });

  it('propagates inbound threadId into the outbox payload', async () => {
    const outbox: Array<{ type: string; chatId: string; payload: unknown }> = [];
    const messenger = createDiscordDemoAdapter(outbox);

    const inbound = normalizeDiscordDemoInbound({
      chatId: 'C123',
      senderId: 'U123',
      text: '!help',
      isGroupChat: true,
      threadId: 'th-1',
    });

    await processDiscordDemoInbound(messenger, inbound, { ownerId: 'owner@s.whatsapp.net' });

    expect(outbox.length).toBeGreaterThan(0);
    const first = outbox[0];
    expect(first.type).toBe('text');

    const payload = first.payload as { replyToId?: unknown; threadId?: unknown };
    expect(payload.replyToId).toBe(inbound.raw.id);
    expect(payload.threadId).toBe('th-1');
  });
});
