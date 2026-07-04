process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformMessenger } from '../src/core/platform-messenger.js';

interface GatewayClientStub {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface GatewayClientParams {
  token: string;
  ownerId: string;
  ownerUserId?: string;
}

function seedEnv(overrides: Record<string, string | undefined> = {}): void {
  const base: Record<string, string | undefined> = {
    MESSAGING_PLATFORM: 'discord',
    OWNER_JID: 'test_owner@s.whatsapp.net',
    OPENROUTER_API_KEY: 'test_key_ci',
    AI_PROVIDER_ORDER: 'openrouter',
    DISCORD_OWNER_ID: '111',
    DISCORD_BOT_TOKEN: 'test_tok',
    DISCORD_GATEWAY_ENABLED: 'true',
    DISCORD_PUBLIC_KEY: undefined,
    DISCORD_DEMO: undefined,
    DISCORD_DIGEST_CHANNEL_ID: undefined,
    DISCORD_RECAP_CHANNEL_ID: undefined,
    WEEKLY_RECAP_ENABLED: 'true',
  };

  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createMessenger(): PlatformMessenger {
  return {
    platform: 'discord',
    sendText: vi.fn<PlatformMessenger['sendText']>(async () => undefined),
    sendPoll: vi.fn<PlatformMessenger['sendPoll']>(async () => undefined),
    sendTextWithRef: vi.fn<PlatformMessenger['sendTextWithRef']>(async (chatId) => ({
      platform: 'discord',
      chatId,
      id: 'msg-1',
      ref: { kind: 'test' },
    })),
    sendDocument: vi.fn<PlatformMessenger['sendDocument']>(async (chatId) => ({
      platform: 'discord',
      chatId,
      id: 'doc-1',
      ref: { kind: 'test' },
    })),
    sendAudio: vi.fn<PlatformMessenger['sendAudio']>(async () => undefined),
    deleteMessage: vi.fn<PlatformMessenger['deleteMessage']>(async () => undefined),
  };
}

function mockImportedSideEffects() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  const createDiscordInteractionsServer = vi.fn();
  const createDiscordDemoServer = vi.fn();

  vi.doMock('../src/middleware/logger.js', () => ({ logger }));
  vi.doMock('../src/platforms/discord/gateway-runtime.js', () => ({ createDiscordInteractionsServer }));
  vi.doMock('../src/platforms/discord/demo-server.js', () => ({ createDiscordDemoServer }));

  return {
    logger,
    createDiscordInteractionsServer,
    createDiscordDemoServer,
  };
}

describe('Discord runtime gateway wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    seedEnv();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('starts the Gateway client, resolves owner DM, registers schedulers, and tears them down', async () => {
    mockImportedSideEffects();
    const adapter = createMessenger();
    const gatewayClient: GatewayClientStub = {
      start: vi.fn<GatewayClientStub['start']>(async () => undefined),
      stop: vi.fn<GatewayClientStub['stop']>(async () => undefined),
    };
    const digestDispose = vi.fn();
    const recapDispose = vi.fn();
    const remindersDispose = vi.fn();
    const rehearsalDispose = vi.fn();
    const agendaDispose = vi.fn();
    const createGatewayClient = vi.fn<(params: GatewayClientParams) => GatewayClientStub>(() => gatewayClient);
    const resolveOwnerDmChannelId = vi.fn(async () => 'dm-222');
    const getOwnerId = vi.fn(() => '111');
    const scheduleDigest = vi.fn(() => digestDispose);
    const scheduleWeeklyRecap = vi.fn(() => recapDispose);
    const scheduleEventReminders = vi.fn(() => remindersDispose);
    const scheduleRehearsalReminders = vi.fn(() => rehearsalDispose);
    const schedulePracticeAgenda = vi.fn(() => agendaDispose);
    const { createDiscordRuntime } = await import('../src/platforms/discord/runtime.js');

    const runtime = createDiscordRuntime({
      createAdapter: () => adapter,
      createGatewayClient,
      resolveOwnerDmChannelId,
      getOwnerId,
      scheduleDigest,
      scheduleWeeklyRecap,
      scheduleEventReminders,
      scheduleRehearsalReminders,
      schedulePracticeAgenda,
    });

    await runtime.start();

    expect(resolveOwnerDmChannelId).toHaveBeenCalledWith('test_tok', '111');
    expect(createGatewayClient).toHaveBeenCalledWith({
      token: 'test_tok',
      ownerId: 'dm-222',
      ownerUserId: '111',
    });
    expect(gatewayClient.start).toHaveBeenCalledTimes(1);
    expect(scheduleDigest).toHaveBeenCalledWith(adapter, 'dm-222');
    expect(scheduleWeeklyRecap).toHaveBeenCalledWith(adapter, 'dm-222');
    expect(scheduleEventReminders).toHaveBeenCalledWith(adapter);
    // Practice schedulers target DISCORD_PRACTICE_CHANNEL_ID ?? ownerDmChannelId (dm-222 here).
    expect(scheduleRehearsalReminders).toHaveBeenCalledWith(adapter, 'dm-222');
    expect(schedulePracticeAgenda).toHaveBeenCalledWith(adapter, 'dm-222');

    await runtime.stop();

    expect(digestDispose).toHaveBeenCalledTimes(1);
    expect(recapDispose).toHaveBeenCalledTimes(1);
    expect(remindersDispose).toHaveBeenCalledTimes(1);
    expect(rehearsalDispose).toHaveBeenCalledTimes(1);
    expect(agendaDispose).toHaveBeenCalledTimes(1);
    expect(gatewayClient.stop).toHaveBeenCalledTimes(1);
  });

  it('skips weekly recap scheduler when recap is disabled', async () => {
    seedEnv({ WEEKLY_RECAP_ENABLED: 'false' });
    mockImportedSideEffects();
    const adapter = createMessenger();
    const gatewayClient: GatewayClientStub = {
      start: vi.fn<GatewayClientStub['start']>(async () => undefined),
      stop: vi.fn<GatewayClientStub['stop']>(async () => undefined),
    };
    const createGatewayClient = vi.fn<(params: GatewayClientParams) => GatewayClientStub>(() => gatewayClient);
    const scheduleWeeklyRecap = vi.fn();
    const { createDiscordRuntime } = await import('../src/platforms/discord/runtime.js');

    const runtime = createDiscordRuntime({
      createAdapter: () => adapter,
      createGatewayClient,
      resolveOwnerDmChannelId: vi.fn(async () => null),
      getOwnerId: vi.fn(() => '111'),
      scheduleDigest: vi.fn(() => vi.fn()),
      scheduleWeeklyRecap,
      scheduleEventReminders: vi.fn(() => vi.fn()),
    });

    await runtime.start();

    expect(scheduleWeeklyRecap).not.toHaveBeenCalled();
    expect(createGatewayClient).toHaveBeenCalledWith({
      token: 'test_tok',
      ownerId: '111',
      ownerUserId: '111',
    });
  });

  it('throws when gateway mode is enabled without an owner user id', async () => {
    const { logger } = mockImportedSideEffects();
    const { createDiscordRuntime } = await import('../src/platforms/discord/runtime.js');

    const runtime = createDiscordRuntime({
      createAdapter: () => createMessenger(),
      createGatewayClient: vi.fn<(params: GatewayClientParams) => GatewayClientStub>(() => ({
        start: vi.fn<GatewayClientStub['start']>(async () => undefined),
        stop: vi.fn<GatewayClientStub['stop']>(async () => undefined),
      })),
      resolveOwnerDmChannelId: vi.fn(async () => null),
      getOwnerId: vi.fn(() => undefined),
      scheduleDigest: vi.fn(() => vi.fn()),
      scheduleWeeklyRecap: vi.fn(() => vi.fn()),
      scheduleEventReminders: vi.fn(() => vi.fn()),
    });

    await expect(runtime.start()).rejects.toThrow('Discord runtime requires DISCORD_OWNER_ID');
    expect(logger.fatal).toHaveBeenCalledWith(
      { platform: 'discord' },
      expect.stringContaining('DISCORD_OWNER_ID'),
    );
  });

  it('uses the interactions server when gateway mode is explicitly disabled', async () => {
    seedEnv({ DISCORD_GATEWAY_ENABLED: 'false', DISCORD_PUBLIC_KEY: 'public_key' });
    mockImportedSideEffects();
    const createInteractionsServer = vi.fn();
    const createGatewayClient = vi.fn<(params: GatewayClientParams) => GatewayClientStub>(() => ({
      start: vi.fn<GatewayClientStub['start']>(async () => undefined),
      stop: vi.fn<GatewayClientStub['stop']>(async () => undefined),
    }));
    const { createDiscordRuntime } = await import('../src/platforms/discord/runtime.js');

    const runtime = createDiscordRuntime({
      createAdapter: () => createMessenger(),
      createGatewayClient,
      createInteractionsServer,
      resolveOwnerDmChannelId: vi.fn(async () => null),
      getOwnerId: vi.fn(() => '111'),
      scheduleDigest: vi.fn(() => vi.fn()),
      scheduleWeeklyRecap: vi.fn(() => vi.fn()),
      scheduleEventReminders: vi.fn(() => vi.fn()),
    });

    await runtime.start();

    expect(createInteractionsServer).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 3003,
      botToken: 'test_tok',
      publicKey: 'public_key',
      ownerId: 'test_owner@s.whatsapp.net',
    });
    expect(createGatewayClient).not.toHaveBeenCalled();
  });
});
