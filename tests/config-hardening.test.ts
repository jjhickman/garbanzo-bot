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
    const { config, instanceId } = await importConfigWithEnv({});

    expect(config.MESSAGING_PLATFORM).toBe('discord');
    expect(config.OWNER_JID).toBeUndefined();
    expect(config.BRIDGE_ENABLED).toBe(false);
    expect(config.BRIDGE_TRANSPORT).toBe('http');
    expect(config.BRIDGE_BROKER_URL).toBeUndefined();
    expect(config.BRIDGE_SUMMARY_INTERVAL_MINUTES).toBe(15);
    expect(config.BRIDGE_MAX_TEXT).toBe(1500);
    expect(config.SHARED_MEMORY_ENABLED).toBe(false);
    expect(config.QDRANT_SHARED_COLLECTION).toBe('garbanzo_shared');
    expect(instanceId).toBe('discord');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('uses INSTANCE_ID as the exported instance id when set', async () => {
    const { config, instanceId } = await importConfigWithEnv({
      MESSAGING_PLATFORM: 'discord',
      INSTANCE_ID: '  discord-band  ',
    });

    expect(config.INSTANCE_ID).toBe('discord-band');
    expect(instanceId).toBe('discord-band');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('requires BRIDGE_BROKER_URL when the enabled bridge uses amqp transport', async () => {
    await expect(importConfigWithEnv({
      MESSAGING_PLATFORM: 'discord',
      BRIDGE_ENABLED: 'true',
      BRIDGE_TRANSPORT: 'amqp',
      BRIDGE_BROKER_URL: undefined,
    })).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '❌ BRIDGE_TRANSPORT=amqp requires BRIDGE_BROKER_URL when BRIDGE_ENABLED=true',
    );
  });

  it('requires MONITORING_TOKEN when the enabled bridge uses http transport', async () => {
    await expect(importConfigWithEnv({
      MESSAGING_PLATFORM: 'discord',
      BRIDGE_ENABLED: 'true',
      BRIDGE_TRANSPORT: 'http',
      MONITORING_TOKEN: undefined,
    })).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '❌ bridge http transport authenticates with MONITORING_TOKEN — set it in .env',
    );
  });

  it('accepts enabled http bridge config when MONITORING_TOKEN is set', async () => {
    const { config } = await importConfigWithEnv({
      MESSAGING_PLATFORM: 'discord',
      BRIDGE_ENABLED: 'true',
      BRIDGE_TRANSPORT: 'http',
      MONITORING_TOKEN: 'bridge-token',
    });

    expect(config.BRIDGE_ENABLED).toBe(true);
    expect(config.BRIDGE_TRANSPORT).toBe('http');
    expect(config.MONITORING_TOKEN).toBe('bridge-token');
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
