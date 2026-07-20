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
    expect(config.BRIDGE_MEDIA_ENABLED).toBe(false);
    expect(config.BRIDGE_MEDIA_MAX_BYTES).toBe(8_388_608);
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

  it('treats blank bridge values as unset, falling through to defaults (setup wizard writes KEY= lines)', async () => {
    // Regression (T6 pack rehearsal): the setup wizard's non-interactive
    // writer emits every bridge key unconditionally — blank when bridging
    // isn't configured. A written-but-empty value must behave exactly like
    // an absent one, not fail enum/coercion/min-length validation and kill
    // the boot with process.exit(1).
    const { config } = await importConfigWithEnv({
      MESSAGING_PLATFORM: 'discord',
      BRIDGE_TRANSPORT: '',
      BRIDGE_SUMMARY_INTERVAL_MINUTES: '',
      BRIDGE_MAX_TEXT: '',
      BRIDGE_MEDIA_ENABLED: '',
      BRIDGE_MEDIA_MAX_BYTES: '',
      QDRANT_SHARED_COLLECTION: '',
    });

    expect(config.BRIDGE_TRANSPORT).toBe('http');
    expect(config.BRIDGE_SUMMARY_INTERVAL_MINUTES).toBe(15);
    expect(config.BRIDGE_MAX_TEXT).toBe(1500);
    expect(config.BRIDGE_MEDIA_ENABLED).toBe(false);
    expect(config.BRIDGE_MEDIA_MAX_BYTES).toBe(8_388_608);
    expect(config.QDRANT_SHARED_COLLECTION).toBe('garbanzo_shared');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('clamps the bridge media byte cap to its supported bounds', async () => {
    const belowMinimum = await importConfigWithEnv({
      MESSAGING_PLATFORM: 'discord',
      BRIDGE_MEDIA_MAX_BYTES: '1',
    });
    expect(belowMinimum.config.BRIDGE_MEDIA_MAX_BYTES).toBe(65_536);

    const aboveMaximum = await importConfigWithEnv({
      MESSAGING_PLATFORM: 'discord',
      BRIDGE_MEDIA_MAX_BYTES: '99999999',
    });
    expect(aboveMaximum.config.BRIDGE_MEDIA_MAX_BYTES).toBe(11_534_336);
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

  it('requires Matrix env when MESSAGING_PLATFORM=matrix', async () => {
    await expect(importConfigWithEnv({
      MESSAGING_PLATFORM: 'matrix',
      MATRIX_HOMESERVER_URL: undefined,
      MATRIX_ACCESS_TOKEN: undefined,
      MATRIX_OWNER_ID: undefined,
    })).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'MATRIX_HOMESERVER_URL is required when MESSAGING_PLATFORM=matrix — set it in .env.matrix',
      ),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'MATRIX_ACCESS_TOKEN is required when MESSAGING_PLATFORM=matrix — set it in .env.matrix',
      ),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'MATRIX_OWNER_ID is required when MESSAGING_PLATFORM=matrix — set it in .env.matrix',
      ),
    );
  });

  it('validates Matrix homeserver URL and owner MXID shape', async () => {
    await expect(importConfigWithEnv({
      MESSAGING_PLATFORM: 'matrix',
      MATRIX_HOMESERVER_URL: 'not-a-url',
      MATRIX_ACCESS_TOKEN: 'test_matrix_token',
      MATRIX_OWNER_ID: 'not-a-mxid',
    })).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('MATRIX_HOMESERVER_URL must be a valid URL'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('MATRIX_OWNER_ID must be a Matrix user id like @user:server'),
    );
  });

  it('accepts MESSAGING_PLATFORM=matrix when required Matrix env is present', async () => {
    const { config, instanceId } = await importConfigWithEnv({
      MESSAGING_PLATFORM: 'matrix',
      MATRIX_HOMESERVER_URL: 'https://matrix.example.org',
      MATRIX_ACCESS_TOKEN: 'test_matrix_token',
      MATRIX_OWNER_ID: '@owner:example.org',
    });

    expect(config.MESSAGING_PLATFORM).toBe('matrix');
    expect(config.MATRIX_HOMESERVER_URL).toBe('https://matrix.example.org');
    expect(config.MATRIX_ACCESS_TOKEN).toBe('test_matrix_token');
    expect(config.MATRIX_OWNER_ID).toBe('@owner:example.org');
    expect(instanceId).toBe('matrix');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('requires TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID when MESSAGING_PLATFORM=telegram', async () => {
    await expect(importConfigWithEnv({
      MESSAGING_PLATFORM: 'telegram',
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_OWNER_ID: undefined,
    })).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'TELEGRAM_BOT_TOKEN is required when MESSAGING_PLATFORM=telegram — set it in .env.telegram',
      ),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'TELEGRAM_OWNER_ID is required when MESSAGING_PLATFORM=telegram — set it in .env.telegram',
      ),
    );
  });

  it('rejects a non-numeric TELEGRAM_OWNER_ID', async () => {
    await expect(importConfigWithEnv({
      MESSAGING_PLATFORM: 'telegram',
      TELEGRAM_BOT_TOKEN: 'test_bot_token',
      TELEGRAM_OWNER_ID: 'not-a-number',
    })).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('TELEGRAM_OWNER_ID must be numeric'),
    );
  });

  it('accepts telegram config when TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID are present', async () => {
    const { config, instanceId } = await importConfigWithEnv({
      MESSAGING_PLATFORM: 'telegram',
      TELEGRAM_BOT_TOKEN: 'test_bot_token',
      TELEGRAM_OWNER_ID: '123456789',
    });

    expect(config.MESSAGING_PLATFORM).toBe('telegram');
    expect(config.TELEGRAM_BOT_TOKEN).toBe('test_bot_token');
    expect(config.TELEGRAM_OWNER_ID).toBe('123456789');
    expect(instanceId).toBe('telegram');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still rejects the removed teams platform value', async () => {
    await expect(importConfigWithEnv({
      MESSAGING_PLATFORM: 'teams',
    })).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid environment variables'),
    );
  });

  describe('QDRANT_COLLECTION smart default (per-instance isolation)', () => {
    it('keeps the plain default when INSTANCE_ID is unset (single-instance upgrade path)', async () => {
      const { config } = await importConfigWithEnv({
        MESSAGING_PLATFORM: 'discord',
        INSTANCE_ID: undefined,
        QDRANT_COLLECTION: undefined,
      });

      expect(config.INSTANCE_ID).toBeUndefined();
      expect(config.QDRANT_COLLECTION).toBe('garbanzo_memory');
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('namespaces the collection to the instance when INSTANCE_ID is set and QDRANT_COLLECTION is not', async () => {
      const { config } = await importConfigWithEnv({
        MESSAGING_PLATFORM: 'discord',
        INSTANCE_ID: 'whatsapp-band',
        QDRANT_COLLECTION: undefined,
      });

      expect(config.INSTANCE_ID).toBe('whatsapp-band');
      expect(config.QDRANT_COLLECTION).toBe('garbanzo_memory_whatsapp-band');
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('lets an explicit QDRANT_COLLECTION win even when INSTANCE_ID is set', async () => {
      const { config } = await importConfigWithEnv({
        MESSAGING_PLATFORM: 'discord',
        INSTANCE_ID: 'whatsapp-band',
        QDRANT_COLLECTION: 'custom_collection',
      });

      expect(config.INSTANCE_ID).toBe('whatsapp-band');
      expect(config.QDRANT_COLLECTION).toBe('custom_collection');
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});
