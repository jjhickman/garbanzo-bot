import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

type ConfigModule = typeof import('../src/utils/config.js');

const baseEnv = {
  OPENROUTER_API_KEY: 'test_key_ci',
  AI_PROVIDER_ORDER: 'openrouter',
};

async function importConfigWithEnv(env: Record<string, string | undefined>): Promise<ConfigModule> {
  vi.resetModules();
  vi.doMock('dotenv', () => ({
    config: vi.fn(),
  }));

  process.env = {
    ...baseEnv,
  };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return import('../src/utils/config.js');
}

describe('config hardening', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('dotenv');
    process.env = { ...originalEnv };
    exitSpy.mockClear();
    errorSpy.mockClear();
  });

  it('treats an empty Discord digest channel id as unset', async () => {
    const { config } = await importConfigWithEnv({
      MESSAGING_PLATFORM: 'discord',
      DISCORD_DIGEST_CHANNEL_ID: '',
    });

    expect(config.DISCORD_DIGEST_CHANNEL_ID).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('treats an empty Qdrant API key as unset', async () => {
    const { config } = await importConfigWithEnv({
      MESSAGING_PLATFORM: 'discord',
      QDRANT_API_KEY: '',
    });

    expect(config.QDRANT_API_KEY).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('parses MONITORING_TOKEN when set and treats an empty value as unset', async () => {
    const withToken = await importConfigWithEnv({
      MESSAGING_PLATFORM: 'discord',
      MONITORING_TOKEN: '  pinned-token  ',
    });
    expect(withToken.config.MONITORING_TOKEN).toBe('pinned-token');

    const withEmptyToken = await importConfigWithEnv({
      MESSAGING_PLATFORM: 'discord',
      MONITORING_TOKEN: '',
    });
    expect(withEmptyToken.config.MONITORING_TOKEN).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('defaults to Discord without requiring OWNER_JID', async () => {
    const { config } = await importConfigWithEnv({});

    expect(config.MESSAGING_PLATFORM).toBe('discord');
    expect(config.OWNER_JID).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('requires OWNER_JID when MESSAGING_PLATFORM=whatsapp', async () => {
    await expect(importConfigWithEnv({
      MESSAGING_PLATFORM: 'whatsapp',
      OWNER_JID: undefined,
    })).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'OWNER_JID is required when MESSAGING_PLATFORM=whatsapp — set it in .env.whatsapp',
      ),
    );
  });

  it('accepts WhatsApp config when OWNER_JID is present', async () => {
    const { config } = await importConfigWithEnv({
      MESSAGING_PLATFORM: 'whatsapp',
      OWNER_JID: 'test_owner@s.whatsapp.net',
    });

    expect(config.MESSAGING_PLATFORM).toBe('whatsapp');
    expect(config.OWNER_JID).toBe('test_owner@s.whatsapp.net');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
