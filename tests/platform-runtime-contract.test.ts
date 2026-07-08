import { afterEach, describe, it, expect, vi } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.TELEGRAM_BOT_TOKEN ??= 'test_tg_token';
process.env.TELEGRAM_OWNER_ID ??= '111';
process.env.MATRIX_HOMESERVER_URL ??= 'https://matrix.example.org';
process.env.MATRIX_ACCESS_TOKEN ??= 'test_matrix_token';
process.env.MATRIX_OWNER_ID ??= '@owner:example.org';

describe('PlatformRuntime contract', () => {
  it('every runtime factory exposes start() and stop()', async () => {
    const { createDiscordRuntime } = await import('../src/platforms/discord/runtime.js');
    const { createSlackRuntime } = await import('../src/platforms/slack/runtime.js');
    const { createTelegramRuntime } = await import('../src/platforms/telegram/runtime.js');
    const { createMatrixRuntime } = await import('../src/platforms/matrix/runtime.js');
    for (const make of [createDiscordRuntime, createSlackRuntime, createTelegramRuntime, createMatrixRuntime]) {
      const rt = make();
      expect(typeof rt.start).toBe('function');
      expect(typeof rt.stop).toBe('function');
      // Never started in this generic contract check, so stop() must be a
      // safe no-op — every runtime factory here tolerates stop-before-start.
      await expect(rt.stop()).resolves.toBeUndefined();
    }
  });
});

describe('getPlatformRuntime for telegram', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../src/utils/config.js');
  });

  it('returns a real PlatformRuntime now that the Telegram adapter core exists', async () => {
    vi.resetModules();
    vi.doMock('../src/utils/config.js', async () => {
      const actual = await vi.importActual<typeof import('../src/utils/config.js')>(
        '../src/utils/config.js',
      );
      return {
        ...actual,
        config: {
          ...actual.config,
          MESSAGING_PLATFORM: 'telegram',
          TELEGRAM_BOT_TOKEN: 'test_tg_token',
          TELEGRAM_OWNER_ID: '111',
        },
      };
    });

    const { getPlatformRuntime } = await import('../src/platforms/index.js');
    const runtime = getPlatformRuntime();

    expect(runtime.platform).toBe('telegram');
    expect(typeof runtime.start).toBe('function');
    expect(typeof runtime.stop).toBe('function');
    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});

describe('getPlatformRuntime for matrix', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../src/utils/config.js');
  });

  it('returns a real PlatformRuntime now that the Matrix adapter core exists', async () => {
    vi.resetModules();
    vi.doMock('../src/utils/config.js', async () => {
      const actual = await vi.importActual<typeof import('../src/utils/config.js')>(
        '../src/utils/config.js',
      );
      return {
        ...actual,
        config: {
          ...actual.config,
          MESSAGING_PLATFORM: 'matrix',
          MATRIX_HOMESERVER_URL: 'https://matrix.example.org',
          MATRIX_ACCESS_TOKEN: 'test_matrix_token',
          MATRIX_OWNER_ID: '@owner:example.org',
        },
      };
    });

    const { getPlatformRuntime } = await import('../src/platforms/index.js');
    const runtime = getPlatformRuntime();

    expect(runtime.platform).toBe('matrix');
    expect(typeof runtime.start).toBe('function');
    expect(typeof runtime.stop).toBe('function');
    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});
