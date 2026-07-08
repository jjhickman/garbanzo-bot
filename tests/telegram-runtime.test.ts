process.env.MESSAGING_PLATFORM ??= 'telegram';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.TELEGRAM_OWNER_ID ??= '111';
process.env.TELEGRAM_BOT_TOKEN ??= 'test_tg_token';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformMessenger } from '../src/core/platform-messenger.js';

interface TelegramClientStub {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function createMessenger(): PlatformMessenger {
  return {
    platform: 'telegram',
    sendText: vi.fn<PlatformMessenger['sendText']>(async () => undefined),
    sendPoll: vi.fn<PlatformMessenger['sendPoll']>(async () => undefined),
    sendTextWithRef: vi.fn<PlatformMessenger['sendTextWithRef']>(async (chatId) => ({
      platform: 'telegram', chatId, id: 'm1', ref: {},
    })),
    sendDocument: vi.fn<PlatformMessenger['sendDocument']>(async (chatId) => ({
      platform: 'telegram', chatId, id: 'd1', ref: {},
    })),
    sendAudio: vi.fn<PlatformMessenger['sendAudio']>(async () => undefined),
    deleteMessage: vi.fn<PlatformMessenger['deleteMessage']>(async () => undefined),
  };
}

describe('Telegram runtime', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('starts the client after resolving the owner chat id, and tears it down on stop', async () => {
    const { createTelegramRuntime } = await import('../src/platforms/telegram/runtime.js');
    const messenger = createMessenger();
    const client: TelegramClientStub = {
      start: vi.fn<TelegramClientStub['start']>(async () => undefined),
      stop: vi.fn<TelegramClientStub['stop']>(async () => undefined),
    };
    const createClient = vi.fn(() => client);
    const resolveOwnerChatId = vi.fn(async () => 'resolved-owner-chat');
    const createAdapter = vi.fn(() => messenger);
    const getOwnerId = vi.fn(() => '111');

    const runtime = createTelegramRuntime({
      createAdapter,
      createClient,
      getOwnerId,
      resolveOwnerChatId,
    });

    await runtime.start();

    expect(createAdapter).toHaveBeenCalledWith('test_tg_token');
    expect(resolveOwnerChatId).toHaveBeenCalledWith('test_tg_token', '111');
    expect(createClient).toHaveBeenCalledWith({
      token: 'test_tg_token',
      ownerId: 'resolved-owner-chat',
      ownerUserId: '111',
    });
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(runtime.getMessenger?.()).toBe(messenger);

    await runtime.stop();
    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(runtime.getMessenger?.()).toBeNull();
  });

  it('falls back to the raw configured owner id when resolution fails', async () => {
    const { createTelegramRuntime } = await import('../src/platforms/telegram/runtime.js');
    const client: TelegramClientStub = {
      start: vi.fn<TelegramClientStub['start']>(async () => undefined),
      stop: vi.fn<TelegramClientStub['stop']>(async () => undefined),
    };
    const createClient = vi.fn(() => client);

    const runtime = createTelegramRuntime({
      createAdapter: () => createMessenger(),
      createClient,
      getOwnerId: () => '111',
      resolveOwnerChatId: vi.fn(async () => null),
    });

    await runtime.start();

    expect(createClient).toHaveBeenCalledWith({
      token: 'test_tg_token',
      ownerId: '111',
      ownerUserId: '111',
    });
  });

  it('throws when TELEGRAM_OWNER_ID cannot be resolved', async () => {
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { fatal: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const { createTelegramRuntime } = await import('../src/platforms/telegram/runtime.js');

    const runtime = createTelegramRuntime({
      createAdapter: () => createMessenger(),
      createClient: vi.fn(() => ({
        start: vi.fn<TelegramClientStub['start']>(async () => undefined),
        stop: vi.fn<TelegramClientStub['stop']>(async () => undefined),
      })),
      getOwnerId: () => undefined,
      resolveOwnerChatId: vi.fn(async () => null),
    });

    await expect(runtime.start()).rejects.toThrow(
      'Telegram runtime requires TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID',
    );

    vi.doUnmock('../src/middleware/logger.js');
  });

  it('is safe to stop before start (never-started contract check)', async () => {
    const { createTelegramRuntime } = await import('../src/platforms/telegram/runtime.js');
    const runtime = createTelegramRuntime();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});
