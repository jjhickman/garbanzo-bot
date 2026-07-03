process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformMessenger } from '../src/core/platform-messenger.js';
import type { DiscordClientLike } from '../src/platforms/discord/gateway-client.js';

type EventHandler = (payload?: unknown) => Promise<void> | void;

class FakeDiscordClient implements DiscordClientLike {
  readonly onHandlers = new Map<string, EventHandler>();
  readonly onceHandlers = new Map<string, EventHandler>();
  readonly login = vi.fn<(token: string) => Promise<string>>(async (token) => token);
  readonly destroy = vi.fn<() => Promise<void>>(async () => undefined);
  user: { id: string } | null = { id: 'bot-user' };

  on(event: string, handler: EventHandler): this {
    this.onHandlers.set(event, handler);
    return this;
  }

  once(event: string, handler: EventHandler): this {
    this.onceHandlers.set(event, handler);
    return this;
  }
}

function createFakeMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    channelId: 'chan-1',
    guildId: 'guild-1',
    content: '@garbanzo hello',
    author: { id: 'author-1', bot: false },
    createdTimestamp: 1_735_689_600_000,
    mentions: {
      users: new Map<string, unknown>([['bot-user', { id: 'bot-user' }]]),
    },
    attachments: new Map<string, unknown>(),
    ...overrides,
  };
}

async function setup() {
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
  const createDiscordAdapter = vi.fn(() => adapter);
  const processDiscordEvent = vi.fn(async () => undefined);
  const getDiscordIntroductionsChannelId = vi.fn<() => string | null>(() => 'intro-chan');
  const getDiscordChannelName = vi.fn(() => 'introductions');

  vi.doMock('../src/platforms/discord/adapter.js', () => ({
    createDiscordAdapter,
  }));
  vi.doMock('../src/platforms/discord/processor.js', () => ({
    processDiscordEvent,
  }));
  vi.doMock('../src/platforms/discord/discord-config.js', () => ({
    getDiscordChannelName,
    getDiscordIntroductionsChannelId,
  }));

  const module = await import('../src/platforms/discord/gateway-client.js');
  const fakeClient = new FakeDiscordClient();
  const gateway = module.createDiscordGatewayClient({
    token: 'test_tok',
    ownerId: 'owner-dm-channel',
    ownerUserId: 'owner-user',
    clientFactory: () => fakeClient,
  });

  return {
    adapter,
    createDiscordAdapter,
    fakeClient,
    gateway,
    getDiscordChannelName,
    getDiscordIntroductionsChannelId,
    processDiscordEvent,
    sendText,
  };
}

describe('Discord Gateway client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('registers gateway handlers and logs in with the provided token', async () => {
    const { createDiscordAdapter, fakeClient, gateway } = await setup();

    await gateway.start();

    expect(createDiscordAdapter).toHaveBeenCalledWith('test_tok');
    expect(fakeClient.onHandlers.has('messageCreate')).toBe(true);
    expect(fakeClient.onHandlers.has('guildMemberAdd')).toBe(true);
    expect(fakeClient.onceHandlers.has('clientReady')).toBe(true);
    expect(fakeClient.onceHandlers.has('ready')).toBe(true);
    expect(fakeClient.login).toHaveBeenCalledWith('test_tok');
  });

  it('maps messageCreate events into Discord payloads for the processor', async () => {
    const { fakeClient, gateway, processDiscordEvent } = await setup();

    await gateway.start();
    await fakeClient.onceHandlers.get('clientReady')?.();
    await fakeClient.onceHandlers.get('ready')?.();
    await fakeClient.onHandlers.get('messageCreate')?.(createFakeMessage());

    expect(processDiscordEvent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        channel_id: 'chan-1',
        content: '@garbanzo hello',
        author: { id: 'author-1', bot: false },
        mentions: [{ id: 'bot-user' }],
      }),
      {
        ownerId: 'owner-dm-channel',
        ownerUserId: 'owner-user',
        botUserId: 'bot-user',
      },
    );
  });

  it('does not forward bot-authored messages', async () => {
    const { fakeClient, gateway, processDiscordEvent } = await setup();

    await gateway.start();
    await fakeClient.onHandlers.get('messageCreate')?.(
      createFakeMessage({ author: { id: 'bot-2', bot: true } }),
    );

    expect(processDiscordEvent).not.toHaveBeenCalled();
  });

  it('sends configured introduction welcomes on guildMemberAdd', async () => {
    const {
      fakeClient,
      gateway,
      getDiscordChannelName,
      getDiscordIntroductionsChannelId,
      sendText,
    } = await setup();

    await gateway.start();
    await fakeClient.onHandlers.get('guildMemberAdd')?.({
      id: 'member-1',
      user: { id: 'new-user', username: 'Remy' },
      displayName: 'Remy Discord',
    });

    expect(getDiscordIntroductionsChannelId).toHaveBeenCalled();
    expect(getDiscordChannelName).toHaveBeenCalledWith('intro-chan');
    expect(sendText).toHaveBeenCalledWith(
      'intro-chan',
      expect.stringContaining('<@new-user>'),
    );
  });

  it('destroys the client on stop', async () => {
    const { fakeClient, gateway } = await setup();

    await gateway.stop();

    expect(fakeClient.destroy).toHaveBeenCalled();
  });

  it('catches handler errors so Discord event dispatch does not reject', async () => {
    const { fakeClient, gateway, processDiscordEvent } = await setup();
    processDiscordEvent.mockRejectedValueOnce(new Error('processor failed'));

    await gateway.start();

    await expect(
      fakeClient.onHandlers.get('messageCreate')?.(createFakeMessage()),
    ).resolves.toBeUndefined();
  });
});
