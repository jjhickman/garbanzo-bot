process.env.MESSAGING_PLATFORM ??= 'matrix';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.MATRIX_HOMESERVER_URL ??= 'https://matrix.example.org';
process.env.MATRIX_ACCESS_TOKEN ??= 'test_matrix_token';
process.env.MATRIX_OWNER_ID ??= '@owner:example.org';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformMessenger } from '../src/core/platform-messenger.js';

interface MatrixClientStub {
  start(): Promise<void>;
  stop(): Promise<void>;
  getMessenger(): PlatformMessenger | null;
}

function createMessenger(): PlatformMessenger {
  return {
    platform: 'matrix',
    sendText: vi.fn<PlatformMessenger['sendText']>(async () => undefined),
    sendPoll: vi.fn<PlatformMessenger['sendPoll']>(async () => undefined),
    sendTextWithRef: vi.fn<PlatformMessenger['sendTextWithRef']>(async (chatId) => ({
      platform: 'matrix', chatId, id: '$m1', ref: {},
    })),
    sendDocument: vi.fn<PlatformMessenger['sendDocument']>(async (chatId) => ({
      platform: 'matrix', chatId, id: '$d1', ref: {},
    })),
    sendAudio: vi.fn<PlatformMessenger['sendAudio']>(async () => undefined),
    deleteMessage: vi.fn<PlatformMessenger['deleteMessage']>(async () => undefined),
  };
}

describe('Matrix runtime', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../src/platforms/matrix/client.js');
    vi.doUnmock('../src/middleware/logger.js');
    vi.doUnmock('../src/utils/config.js');
  });

  it('starts the client and exposes its messenger for bridge delivery', async () => {
    vi.doMock('../src/platforms/matrix/client.js', () => ({
      createMatrixClient: vi.fn(),
    }));
    const { createMatrixRuntime } = await import('../src/platforms/matrix/runtime.js');
    const { createMatrixClient } = await import('../src/platforms/matrix/client.js');
    const messenger = createMessenger();
    const client: MatrixClientStub = {
      start: vi.fn<MatrixClientStub['start']>(async () => undefined),
      stop: vi.fn<MatrixClientStub['stop']>(async () => undefined),
      getMessenger: vi.fn(() => messenger),
    };
    const createClient = vi.mocked(createMatrixClient);
    createClient.mockReturnValue(client as never);

    const runtime = createMatrixRuntime({
      createClient,
      getOwnerId: () => '@owner:example.org',
    });

    await runtime.start();

    expect(createClient).toHaveBeenCalledWith({
      homeserverUrl: 'https://matrix.example.org',
      accessToken: 'test_matrix_token',
      ownerId: '@owner:example.org',
      resolveOwnerRoomId: expect.any(Function),
    });
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(runtime.getMessenger?.()).toBe(messenger);

    await runtime.stop();
    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(runtime.getMessenger?.()).toBeNull();
  });

  it('throws when Matrix config is incomplete', async () => {
    vi.doMock('../src/platforms/matrix/client.js', () => ({
      createMatrixClient: vi.fn(),
    }));
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { fatal: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../src/utils/config.js', () => ({
      config: {
        MESSAGING_PLATFORM: 'matrix',
        MATRIX_HOMESERVER_URL: undefined,
        MATRIX_ACCESS_TOKEN: undefined,
        MATRIX_OWNER_ID: undefined,
        MATRIX_ROOMS_CONFIG_PATH: 'config/matrix-rooms.json',
      },
    }));
    const { createMatrixRuntime } = await import('../src/platforms/matrix/runtime.js');

    const runtime = createMatrixRuntime({
      createClient: vi.fn(() => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        getMessenger: vi.fn(() => null),
      })),
      getOwnerId: () => undefined,
    });

    await expect(runtime.start()).rejects.toThrow(
      'Matrix runtime requires MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, and MATRIX_OWNER_ID',
    );
  });

  it('is safe to stop before start', async () => {
    vi.doMock('../src/platforms/matrix/client.js', () => ({
      createMatrixClient: vi.fn(() => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        getMessenger: vi.fn(() => null),
      })),
    }));
    const { createMatrixRuntime } = await import('../src/platforms/matrix/runtime.js');
    const runtime = createMatrixRuntime();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});
