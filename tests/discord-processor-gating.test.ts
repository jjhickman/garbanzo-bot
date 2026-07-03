process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageContext } from '../src/ai/persona.js';
import type { VisionImage } from '../src/core/vision.js';
import type { DiscordDemoOutboxEntry } from '../src/platforms/discord/adapter.js';

type FeaturePredicate = (chatId: string, feature: string) => boolean;
type MockGetResponse = (
  query: string,
  ctx: MessageContext,
  isFeatureEnabled: FeaturePredicate,
  visionImages?: VisionImage[],
) => Promise<string | null>;

function setupMocks() {
  const isDiscordChannelEnabled = vi.fn<(channelId: string) => boolean>((channelId) => channelId !== 'disabled');
  const discordChannelRequiresMention = vi.fn<(channelId: string) => boolean>((channelId) => channelId !== 'open');
  const isDiscordFeatureEnabled = vi.fn<(channelId: string, feature: string) => boolean>(
    (channelId, feature) => channelId === 'open' && feature === 'weather',
  );
  const getDiscordIntroductionsChannelId = vi.fn<() => string | null>(() => 'intros');
  const getDiscordEventsChannelId = vi.fn<() => string | null>(() => 'events');
  const getDiscordChannelName = vi.fn<(channelId: string) => string | undefined>(
    (channelId) => channelId === 'enabled' ? 'general' : undefined,
  );
  const getResponse = vi.fn<MockGetResponse>(async (query, ctx, featureEnabled) => {
    const weatherEnabled = featureEnabled(ctx.groupJid, 'weather');
    return `assistant:${query}:weather=${weatherEnabled ? 'on' : 'off'}`;
  });

  vi.doMock('../src/platforms/discord/discord-config.js', () => ({
    isDiscordChannelEnabled,
    discordChannelRequiresMention,
    isDiscordFeatureEnabled,
    getDiscordChannelName,
    getDiscordIntroductionsChannelId,
    getDiscordEventsChannelId,
  }));

  vi.doMock('../src/core/response-router.js', () => ({
    getResponse,
  }));

  return {
    isDiscordChannelEnabled,
    discordChannelRequiresMention,
    isDiscordFeatureEnabled,
    getDiscordChannelName,
    getResponse,
  };
}

async function importDiscordProcessor() {
  const adapterModule = await import('../src/platforms/discord/adapter.js');
  const processorModule = await import('../src/platforms/discord/processor.js');
  return {
    createDiscordDemoAdapter: adapterModule.createDiscordDemoAdapter,
    normalizeDiscordDemoInbound: processorModule.normalizeDiscordDemoInbound,
    processDiscordEvent: processorModule.processDiscordEvent,
    processDiscordDemoInbound: processorModule.processDiscordDemoInbound,
  };
}

describe('Discord processor config gating', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('ignores disabled production channels before sending or calling the assistant', async () => {
    const mocks = setupMocks();
    const { createDiscordDemoAdapter, processDiscordEvent } = await importDiscordProcessor();
    const outbox: DiscordDemoOutboxEntry[] = [];
    const messenger = createDiscordDemoAdapter(outbox);

    await processDiscordEvent(
      messenger,
      {
        id: 'message-1',
        channel_id: 'disabled',
        guild_id: 'guild-1',
        content: '<@bot-user> hello',
        author: { id: 'user-1' },
        timestamp: new Date().toISOString(),
        mentions: [{ id: 'bot-user' }],
      },
      { ownerId: 'owner-dm', ownerUserId: 'owner-user', botUserId: 'bot-user' },
    );

    expect(mocks.isDiscordChannelEnabled).toHaveBeenCalledWith('disabled');
    expect(outbox).toHaveLength(0);
    expect(mocks.getResponse).not.toHaveBeenCalled();
  });

  it('processes mid-sentence structured mentions in require-mention production channels', async () => {
    const mocks = setupMocks();
    const { createDiscordDemoAdapter, processDiscordEvent } = await importDiscordProcessor();
    const outbox: DiscordDemoOutboxEntry[] = [];
    const messenger = createDiscordDemoAdapter(outbox);

    await processDiscordEvent(
      messenger,
      {
        id: 'message-mid-mention',
        channel_id: 'enabled',
        guild_id: 'guild-1',
        content: 'hey <@bot-user> can you help?',
        author: { id: 'user-4' },
        timestamp: new Date().toISOString(),
        mentions: [{ id: 'bot-user' }],
      },
      { ownerId: 'owner-dm', ownerUserId: 'owner-user', botUserId: 'bot-user' },
    );

    expect(mocks.discordChannelRequiresMention).toHaveBeenCalledWith('enabled');
    expect(mocks.getResponse).toHaveBeenCalledWith(
      'hey <@bot-user> can you help?',
      expect.objectContaining({
        groupName: 'general',
        groupJid: 'enabled',
        senderJid: 'user-4',
      }),
      expect.any(Function),
      undefined,
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.payload).toMatchObject({
      text: 'assistant:hey <@bot-user> can you help?:weather=off',
    });
  });

  it('strips leading structured mentions in require-mention production channels', async () => {
    const mocks = setupMocks();
    const { createDiscordDemoAdapter, processDiscordEvent } = await importDiscordProcessor();
    const outbox: DiscordDemoOutboxEntry[] = [];
    const messenger = createDiscordDemoAdapter(outbox);

    await processDiscordEvent(
      messenger,
      {
        id: 'message-leading-mention',
        channel_id: 'enabled',
        guild_id: 'guild-1',
        content: '<@12345> help please',
        author: { id: 'user-6' },
        timestamp: new Date().toISOString(),
        mentions: [{ id: '12345' }],
      },
      { ownerId: 'owner-dm', ownerUserId: 'owner-user', botUserId: '12345' },
    );

    expect(mocks.getResponse).toHaveBeenCalledWith(
      'help please',
      expect.objectContaining({
        groupName: 'general',
        groupJid: 'enabled',
        senderJid: 'user-6',
      }),
      expect.any(Function),
      undefined,
    );
    expect(outbox[0]?.payload).toMatchObject({
      text: 'assistant:help please:weather=off',
    });
  });

  it('ignores require-mention production messages without a mention or bang', async () => {
    const mocks = setupMocks();
    const { createDiscordDemoAdapter, processDiscordEvent } = await importDiscordProcessor();
    const outbox: DiscordDemoOutboxEntry[] = [];
    const messenger = createDiscordDemoAdapter(outbox);

    await processDiscordEvent(
      messenger,
      {
        id: 'message-no-address',
        channel_id: 'enabled',
        guild_id: 'guild-1',
        content: 'can you help?',
        author: { id: 'user-5' },
        timestamp: new Date().toISOString(),
        mentions: [],
      },
      { ownerId: 'owner-dm', ownerUserId: 'owner-user', botUserId: 'bot-user' },
    );

    expect(mocks.discordChannelRequiresMention).toHaveBeenCalledWith('enabled');
    expect(mocks.getResponse).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
  });

  it('processes non-mention messages in channels that do not require mentions', async () => {
    const mocks = setupMocks();
    const { createDiscordDemoAdapter, normalizeDiscordDemoInbound, processDiscordDemoInbound } = await importDiscordProcessor();
    const outbox: DiscordDemoOutboxEntry[] = [];
    const messenger = createDiscordDemoAdapter(outbox);
    const inbound = normalizeDiscordDemoInbound({
      chatId: 'open',
      senderId: 'user-2',
      text: 'what is the weather?',
      isGroupChat: true,
    });

    await processDiscordDemoInbound(messenger, inbound, { ownerId: 'owner-dm', ownerUserId: 'owner-user' });

    expect(mocks.discordChannelRequiresMention).toHaveBeenCalledWith('open');
    expect(mocks.getResponse).toHaveBeenCalledWith(
      'what is the weather?',
      expect.objectContaining({ groupJid: 'open', senderJid: 'user-2' }),
      expect.any(Function),
      undefined,
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.chatId).toBe('open');
    expect(outbox[0]?.payload).toMatchObject({
      text: 'assistant:what is the weather?:weather=on',
      replyToId: inbound.raw.id,
    });
  });

  it('gates owner DMs by Discord owner user identity', async () => {
    const mocks = setupMocks();
    const { createDiscordDemoAdapter, normalizeDiscordDemoInbound, processDiscordDemoInbound } = await importDiscordProcessor();
    const outbox: DiscordDemoOutboxEntry[] = [];
    const messenger = createDiscordDemoAdapter(outbox);

    const nonOwner = normalizeDiscordDemoInbound({
      chatId: 'dm-channel',
      senderId: 'not-owner',
      text: 'status?',
      isGroupChat: false,
    });
    await processDiscordDemoInbound(messenger, nonOwner, { ownerId: 'owner-dm', ownerUserId: 'owner-user' });

    expect(outbox).toHaveLength(0);
    expect(mocks.getResponse).not.toHaveBeenCalled();

    const owner = normalizeDiscordDemoInbound({
      chatId: 'dm-channel',
      senderId: 'owner-user',
      text: 'status?',
      isGroupChat: false,
    });
    await processDiscordDemoInbound(messenger, owner, { ownerId: 'owner-dm', ownerUserId: 'owner-user' });

    expect(mocks.getResponse).toHaveBeenCalledTimes(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.chatId).toBe('dm-channel');
  });

  it('demo path bypasses channel + feature gating (public demo works without config)', async () => {
    // 'disabled' is reported disabled by isDiscordChannelEnabled and its
    // weather feature is off in isDiscordFeatureEnabled — but the demo entry
    // must still process it. If the demo bypass override were dropped, this
    // fails (the other tests would not, since they use "enabled" channels).
    const mocks = setupMocks();
    const { createDiscordDemoAdapter, normalizeDiscordDemoInbound, processDiscordDemoInbound } = await importDiscordProcessor();
    const outbox: DiscordDemoOutboxEntry[] = [];
    const messenger = createDiscordDemoAdapter(outbox);
    const inbound = normalizeDiscordDemoInbound({
      chatId: 'disabled',
      senderId: 'user-9',
      text: '!weather please',
      isGroupChat: true,
    });

    await processDiscordDemoInbound(messenger, inbound, { ownerId: 'owner-dm', ownerUserId: 'owner-user' });

    // Processed despite the channel being disabled and its feature off.
    expect(mocks.getResponse).toHaveBeenCalledTimes(1);
    expect(outbox).toHaveLength(1);
    // weather=on proves the feature predicate was bypassed (real predicate → off for 'disabled').
    expect(outbox[0]?.payload).toMatchObject({ text: 'assistant:!weather please:weather=on' });
  });

  it('routes feature checks through the Discord feature predicate (production path)', async () => {
    // Feature gating is a PRODUCTION behavior; the demo path deliberately
    // bypasses it (public demo works without channel config), so this is
    // verified through processDiscordEvent, not the demo entry.
    const mocks = setupMocks();
    const { createDiscordDemoAdapter, processDiscordEvent } = await importDiscordProcessor();
    const outbox: DiscordDemoOutboxEntry[] = [];
    const messenger = createDiscordDemoAdapter(outbox);

    await processDiscordEvent(
      messenger,
      {
        id: 'message-2',
        channel_id: 'open',
        guild_id: 'guild-1',
        content: 'should I bring an umbrella?',
        author: { id: 'user-3' },
        timestamp: new Date().toISOString(),
      },
      { ownerId: 'owner-dm', ownerUserId: 'owner-user' },
    );

    expect(mocks.isDiscordFeatureEnabled).toHaveBeenCalledWith('open', 'weather');
    expect(outbox[0]?.payload).toMatchObject({
      text: 'assistant:should I bring an umbrella?:weather=on',
    });
  });
});
