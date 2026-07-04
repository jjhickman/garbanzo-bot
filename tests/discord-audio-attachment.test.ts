process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformMessenger } from '../src/core/platform-messenger.js';

function createFakeMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    channelId: 'chan-1',
    guildId: 'guild-1',
    content: '!idea some idea',
    author: { id: 'author-1', bot: false },
    createdTimestamp: 1_735_689_600_000,
    mentions: {
      users: new Map<string, unknown>(),
    },
    attachments: new Map<string, unknown>(),
    ...overrides,
  };
}

describe('Discord audio attachment plumbing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('mapMessageToPayload', () => {
    it('sets audio when an audio/mpeg attachment is present', async () => {
      const { mapMessageToPayload } = await import('../src/platforms/discord/gateway-client.js');

      const payload = mapMessageToPayload(createFakeMessage({
        attachments: new Map<string, unknown>([
          ['att-1', {
            url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp3',
            contentType: 'audio/mpeg',
            name: 'clip.mp3',
          }],
        ]),
      }));

      expect(payload.audio).toEqual({
        url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp3',
        contentType: 'audio/mpeg',
      });
    });

    it('sets audio inferred from a .m4a filename when contentType is missing', async () => {
      const { mapMessageToPayload } = await import('../src/platforms/discord/gateway-client.js');

      const payload = mapMessageToPayload(createFakeMessage({
        attachments: new Map<string, unknown>([
          ['att-1', {
            url: 'https://cdn.discordapp.com/attachments/1/2/voice-memo.m4a',
            name: 'voice-memo.m4a',
          }],
        ]),
      }));

      expect(payload.audio).toBeDefined();
      expect(payload.audio?.url).toBe('https://cdn.discordapp.com/attachments/1/2/voice-memo.m4a');
      expect(payload.audio?.contentType).toMatch(/^audio\//);
    });

    it('prefers the inferred audio type when the declared contentType is non-audio', async () => {
      const { mapMessageToPayload } = await import('../src/platforms/discord/gateway-client.js');

      // Discord sometimes declares application/octet-stream for .m4a etc. — the
      // extension makes it audio, so the returned contentType must be audio/*.
      const payload = mapMessageToPayload(createFakeMessage({
        attachments: new Map<string, unknown>([
          ['att-1', {
            url: 'https://cdn.discordapp.com/attachments/1/2/riff.m4a',
            name: 'riff.m4a',
            contentType: 'application/octet-stream',
          }],
        ]),
      }));

      expect(payload.audio?.url).toBe('https://cdn.discordapp.com/attachments/1/2/riff.m4a');
      expect(payload.audio?.contentType).toMatch(/^audio\//);
      expect(payload.audio?.contentType).not.toBe('application/octet-stream');
    });

    it('picks the first audio attachment when multiple attachments are present', async () => {
      const { mapMessageToPayload } = await import('../src/platforms/discord/gateway-client.js');

      const payload = mapMessageToPayload(createFakeMessage({
        attachments: new Map<string, unknown>([
          ['att-image', {
            url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
            contentType: 'image/png',
            name: 'photo.png',
          }],
          ['att-audio', {
            url: 'https://cdn.discordapp.com/attachments/1/2/clip.wav',
            contentType: 'audio/wav',
            name: 'clip.wav',
          }],
        ]),
      }));

      expect(payload.audio).toEqual({
        url: 'https://cdn.discordapp.com/attachments/1/2/clip.wav',
        contentType: 'audio/wav',
      });
    });

    it('leaves audio undefined when there is only an image attachment (hasVisualMedia unaffected)', async () => {
      const { mapMessageToPayload } = await import('../src/platforms/discord/gateway-client.js');

      const payload = mapMessageToPayload(createFakeMessage({
        attachments: new Map<string, unknown>([
          ['att-image', {
            url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
            contentType: 'image/png',
            name: 'photo.png',
          }],
        ]),
      }));

      expect(payload.audio).toBeUndefined();
      expect(payload.attachments.length).toBe(1);
    });

    it('leaves audio undefined when there are no attachments', async () => {
      const { mapMessageToPayload } = await import('../src/platforms/discord/gateway-client.js');

      const payload = mapMessageToPayload(createFakeMessage());

      expect(payload.audio).toBeUndefined();
    });
  });

  describe('processDiscordEvent -> InboundMessage -> group handler', () => {
    async function setupProcessor() {
      vi.resetModules();

      const sendText = vi.fn<PlatformMessenger['sendText']>(async () => undefined);
      const adapter: PlatformMessenger = {
        platform: 'discord',
        sendText,
        sendPoll: vi.fn<PlatformMessenger['sendPoll']>(async () => undefined),
        sendDocument: vi.fn<PlatformMessenger['sendDocument']>(async () => ({
          platform: 'discord',
          chatId: 'chan-1',
          id: 'doc-1',
        })),
        sendAudio: vi.fn<PlatformMessenger['sendAudio']>(async () => undefined),
        deleteMessage: vi.fn<PlatformMessenger['deleteMessage']>(async () => undefined),
      };

      const processGroupMessage = vi.fn(async () => undefined);
      vi.doMock('../src/core/process-group-message.js', () => ({
        processGroupMessage,
      }));

      vi.doMock('../src/platforms/discord/discord-config.js', () => ({
        isDiscordChannelEnabled: vi.fn(() => true),
        discordChannelRequiresMention: vi.fn(() => true),
        isDiscordFeatureEnabled: vi.fn(() => true),
        isBandMember: vi.fn(() => false),
        getDiscordChannelName: vi.fn(() => 'general'),
        getDiscordIntroductionsChannelId: vi.fn(() => null),
        getDiscordEventsChannelId: vi.fn(() => null),
      }));

      const module = await import('../src/platforms/discord/processor.js');
      return { adapter, module, processGroupMessage };
    }

    it('carries the audio field from the raw event through to processGroupMessage', async () => {
      const { adapter, module, processGroupMessage } = await setupProcessor();

      const event = {
        id: 'msg-1',
        channel_id: 'chan-1',
        guild_id: 'guild-1',
        content: '!idea some idea',
        author: { id: 'author-1', bot: false },
        timestamp: new Date().toISOString(),
        audio: { url: 'https://cdn.discordapp.com/x/clip.mp3', contentType: 'audio/mpeg' },
      };

      await module.processDiscordEvent(adapter, event, {
        ownerId: 'owner-dm-channel',
        ownerUserId: 'author-1',
        botUserId: 'bot-user',
      });

      expect(processGroupMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          audio: { url: 'https://cdn.discordapp.com/x/clip.mp3', contentType: 'audio/mpeg' },
        }),
      );
    });

    it('leaves audio undefined for processGroupMessage when the raw event has none', async () => {
      const { adapter, module, processGroupMessage } = await setupProcessor();

      const event = {
        id: 'msg-2',
        channel_id: 'chan-1',
        guild_id: 'guild-1',
        content: '!idea some idea',
        author: { id: 'author-1', bot: false },
        timestamp: new Date().toISOString(),
      };

      await module.processDiscordEvent(adapter, event, {
        ownerId: 'owner-dm-channel',
        ownerUserId: 'author-1',
        botUserId: 'bot-user',
      });

      expect(processGroupMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          audio: undefined,
        }),
      );
    });
  });
});
