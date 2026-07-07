process.env.MESSAGING_PLATFORM ??= 'telegram';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.TELEGRAM_OWNER_ID ??= '111';
process.env.TELEGRAM_BOT_TOKEN ??= 'test_tg_token';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalChatsConfigPath = process.env.TELEGRAM_CHATS_CONFIG_PATH;
const originalTelegramOwnerId = process.env.TELEGRAM_OWNER_ID;

function writeFixture(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'garbanzo-telegram-config-'));
  const path = join(dir, 'telegram-chats.json');
  writeFileSync(path, JSON.stringify(body), 'utf8');
  return path;
}

function writeMalformedFixture(raw: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'garbanzo-telegram-config-'));
  const path = join(dir, 'telegram-chats.json');
  writeFileSync(path, raw, 'utf8');
  return path;
}

async function importTelegramConfig(path: string, ownerId = '111') {
  vi.resetModules();
  process.env.TELEGRAM_CHATS_CONFIG_PATH = path;
  process.env.TELEGRAM_OWNER_ID = ownerId;
  return import('../src/platforms/telegram/telegram-config.js');
}

describe('Telegram chat config', () => {
  afterEach(() => {
    vi.resetModules();
    if (originalChatsConfigPath === undefined) {
      delete process.env.TELEGRAM_CHATS_CONFIG_PATH;
    } else {
      process.env.TELEGRAM_CHATS_CONFIG_PATH = originalChatsConfigPath;
    }
    if (originalTelegramOwnerId === undefined) {
      delete process.env.TELEGRAM_OWNER_ID;
    } else {
      process.env.TELEGRAM_OWNER_ID = originalTelegramOwnerId;
    }
  });

  describe('fail-soft loader trio', () => {
    it('falls back to all-disabled when the config file is missing', async () => {
      const telegramConfig = await importTelegramConfig(join(tmpdir(), 'missing-telegram-chats.json'));

      expect(telegramConfig.isTelegramChatEnabled('chat-any')).toBe(false);
      expect(telegramConfig.telegramChatRequiresMention('chat-any')).toBe(true);
      expect(telegramConfig.isTelegramFeatureEnabled('chat-any', 'events')).toBe(false);
      expect(telegramConfig.getTelegramChatName('chat-any')).toBeUndefined();
    });

    it('falls back to all-disabled when the config file is malformed JSON', async () => {
      const path = writeMalformedFixture('{ this is not valid json');
      const telegramConfig = await importTelegramConfig(path);

      expect(telegramConfig.isTelegramChatEnabled('chat-any')).toBe(false);
      expect(telegramConfig.telegramChatRequiresMention('chat-any')).toBe(true);

      rmSync(join(path, '..'), { recursive: true, force: true });
    });

    it('falls back to all-disabled when the config fails schema validation', async () => {
      const path = writeFixture({ chats: { 'chat-1': { enabled: 'not-a-boolean' } } });
      const telegramConfig = await importTelegramConfig(path);

      expect(telegramConfig.isTelegramChatEnabled('chat-1')).toBe(false);

      rmSync(join(path, '..'), { recursive: true, force: true });
    });

    it('loads a valid config file', async () => {
      const path = writeFixture({
        chats: {
          'chat-1': { name: 'general', enabled: true },
        },
      });
      const telegramConfig = await importTelegramConfig(path);

      expect(telegramConfig.isTelegramChatEnabled('chat-1')).toBe(true);
      expect(telegramConfig.getTelegramChatName('chat-1')).toBe('general');

      rmSync(join(path, '..'), { recursive: true, force: true });
    });
  });

  it('disables unknown and explicitly disabled chats', async () => {
    const path = writeFixture({
      chats: {
        'chat-enabled': { name: 'general' },
        'chat-disabled': { name: 'quiet', enabled: false },
      },
    });
    const telegramConfig = await importTelegramConfig(path);

    expect(telegramConfig.isTelegramChatEnabled('chat-enabled')).toBe(true);
    expect(telegramConfig.isTelegramChatEnabled('chat-disabled')).toBe(false);
    expect(telegramConfig.isTelegramChatEnabled('missing')).toBe(false);

    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('defaults requireMention to true (privacy-mode-ON default) and allows explicit false', async () => {
    const path = writeFixture({
      chats: {
        'chat-default': { name: 'general' },
        'chat-open': { name: 'bot-talk', requireMention: false },
      },
    });
    const telegramConfig = await importTelegramConfig(path);

    expect(telegramConfig.telegramChatRequiresMention('chat-default')).toBe(true);
    expect(telegramConfig.telegramChatRequiresMention('chat-open')).toBe(false);
    expect(telegramConfig.telegramChatRequiresMention('missing')).toBe(true);

    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('gates features only when enabledFeatures is present', async () => {
    const path = writeFixture({
      chats: {
        'chat-all': { name: 'general' },
        'chat-gated': { name: 'events', enabledFeatures: ['events', 'weather'] },
      },
    });
    const telegramConfig = await importTelegramConfig(path);

    expect(telegramConfig.isTelegramFeatureEnabled('chat-all', 'venues')).toBe(true);
    expect(telegramConfig.isTelegramFeatureEnabled('chat-gated', 'events')).toBe(true);
    expect(telegramConfig.isTelegramFeatureEnabled('chat-gated', 'venues')).toBe(false);
    expect(telegramConfig.isTelegramFeatureEnabled('missing', 'events')).toBe(false);

    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('reads chat names and an optional persona override', async () => {
    const path = writeFixture({
      chats: {
        'chat-1': { name: 'general', persona: 'riff' },
      },
    });
    const telegramConfig = await importTelegramConfig(path);

    expect(telegramConfig.getTelegramChatName('chat-1')).toBe('general');
    expect(telegramConfig.getTelegramChatPersona('chat-1')).toBe('riff');
    expect(telegramConfig.getTelegramChatPersona('missing')).toBeUndefined();

    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('prefers TELEGRAM_OWNER_ID env over file ownerId', async () => {
    const path = writeFixture({ ownerId: 'file-owner', chats: {} });
    const withEnvOwner = await importTelegramConfig(path, '111');

    expect(withEnvOwner.getTelegramOwnerId()).toBe('111');

    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('falls back to the file ownerId when config.TELEGRAM_OWNER_ID is unset', async () => {
    // TELEGRAM_OWNER_ID is required at the config/index.ts layer whenever
    // MESSAGING_PLATFORM=telegram, so this exercises telegram-config.ts's own
    // fallback precedence directly (mirrors discord-config.ts's shape) via a
    // mocked config module rather than an actually-invalid process.env.
    const path = writeFixture({ ownerId: 'file-owner', chats: {} });

    vi.resetModules();
    process.env.TELEGRAM_CHATS_CONFIG_PATH = path;
    vi.doMock('../src/utils/config.js', async () => {
      const actual = await vi.importActual<typeof import('../src/utils/config.js')>(
        '../src/utils/config.js',
      );
      return {
        ...actual,
        config: { ...actual.config, TELEGRAM_OWNER_ID: undefined, TELEGRAM_CHATS_CONFIG_PATH: path },
      };
    });

    const withFileOwner = await import('../src/platforms/telegram/telegram-config.js');
    expect(withFileOwner.getTelegramOwnerId()).toBe('file-owner');

    vi.doUnmock('../src/utils/config.js');
    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('F10 (T2 review): keeps config/telegram-chats.example.json valid against the loader schema', async () => {
    const { TelegramChatsConfigSchema } = await import('../src/platforms/telegram/telegram-config.js');
    const example = JSON.parse(readFileSync(resolve('config/telegram-chats.example.json'), 'utf8')) as unknown;

    expect(TelegramChatsConfigSchema.safeParse(example).success).toBe(true);
  });
});
