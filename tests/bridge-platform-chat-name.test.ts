process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../src/core/inbound-message.js';
import type { PlatformMessenger } from '../src/core/platform-messenger.js';

const processInboundMessage = vi.fn(async () => undefined);

vi.mock('../src/core/process-inbound-message.js', () => ({
  processInboundMessage,
}));

function fakeMessenger(): PlatformMessenger {
  return {
    platform: 'discord',
    sendText: vi.fn<PlatformMessenger['sendText']>(async () => undefined),
    sendPoll: vi.fn<PlatformMessenger['sendPoll']>(async () => undefined),
    sendDocument: vi.fn<PlatformMessenger['sendDocument']>(async () => ({
      platform: 'discord',
      chatId: 'chan-1',
      id: 'doc-1',
    })),
    sendAudio: vi.fn<PlatformMessenger['sendAudio']>(async () => undefined),
    deleteMessage: vi.fn<PlatformMessenger['deleteMessage']>(async () => undefined),
  };
}

describe('bridge platform chatName plumbing', () => {
  beforeEach(() => {
    vi.resetModules();
    processInboundMessage.mockClear();
  });

  it('sets Discord inbound chatName from channel config', async () => {
    vi.doMock('../src/platforms/discord/discord-config.js', () => ({
      isDiscordChannelEnabled: vi.fn(() => true),
      discordChannelRequiresMention: vi.fn(() => true),
      isDiscordFeatureEnabled: vi.fn(() => true),
      isBandMember: vi.fn(() => false),
      getDiscordChannelName: vi.fn(() => 'practice'),
      getDiscordIntroductionsChannelId: vi.fn(() => null),
      getDiscordEventsChannelId: vi.fn(() => null),
    }));
    const { processDiscordEvent } = await import('../src/platforms/discord/processor.js');

    await processDiscordEvent(fakeMessenger(), {
      id: 'msg-1',
      channel_id: 'chan-1',
      guild_id: 'guild-1',
      content: 'hello',
      author: { id: 'author-1', bot: false },
      timestamp: new Date().toISOString(),
    }, { ownerId: 'owner-dm', ownerUserId: 'owner-user', botUserId: 'bot-user' });

    const inbound = processInboundMessage.mock.calls[0]?.[1] as InboundMessage | undefined;
    expect(inbound?.chatName).toBe('practice');
  });

  it('sets WhatsApp inbound chatName from groups config', async () => {
    vi.doMock('../src/core/groups-config.js', () => ({
      getGroupName: vi.fn(() => 'General'),
    }));
    const { normalizeWhatsAppInboundMessage } = await import('../src/platforms/whatsapp/inbound.js');

    const inbound = normalizeWhatsAppInboundMessage({} as never, {
      key: {
        remoteJid: 'group-1@g.us',
        participant: 'sender@s.whatsapp.net',
        id: 'msg-1',
      },
      messageTimestamp: 1_800_000_000,
      message: { conversation: 'hello' },
      pushName: 'Ana',
    } as never);

    expect(inbound?.chatName).toBe('General');
  });

  it('does not propagate the WhatsApp unknown-group sentinel as chatName', async () => {
    vi.doMock('../src/core/groups-config.js', () => ({
      getGroupName: vi.fn(() => 'Unknown Group'),
    }));
    const { normalizeWhatsAppInboundMessage } = await import('../src/platforms/whatsapp/inbound.js');

    const inbound = normalizeWhatsAppInboundMessage({} as never, {
      key: {
        remoteJid: 'unknown@g.us',
        participant: 'sender@s.whatsapp.net',
        id: 'msg-1',
      },
      messageTimestamp: 1_800_000_000,
      message: { conversation: 'hello' },
    } as never);

    expect(inbound?.chatName).toBeUndefined();
  });
});
