import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

const baseEnv = {
  MESSAGING_PLATFORM: 'discord',
  OPENROUTER_API_KEY: 'test_key_ci',
  AI_PROVIDER_ORDER: 'openrouter',
};

async function importConfigWithEnv(env: Record<string, string | undefined>): Promise<void> {
  vi.resetModules();
  vi.doMock('dotenv', () => ({
    config: vi.fn(),
  }));

  process.env = { ...baseEnv };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  await import('../src/utils/config.js');
}

async function expectBootFailure(
  env: Record<string, string | undefined>,
  expectedIssue: string,
): Promise<void> {
  await expect(importConfigWithEnv(env)).rejects.toThrow('process.exit called');
  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(expectedIssue));
}

describe('boot config validator safety net', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('dotenv');
    process.env = { ...originalEnv };
    exitSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
  });

  it('exits on a Zod schema failure', async () => {
    await expectBootFailure(
      { MESSAGING_PLATFORM: 'unsupported' },
      'Invalid environment variables',
    );
  });

  it('exits when provider-order normalization produces no providers', async () => {
    await expectBootFailure(
      { AI_PROVIDER_ORDER: ' , ' },
      'AI_PROVIDER_ORDER must include at least one provider',
    );
  });

  it('exits when provider-order normalization finds an invalid provider', async () => {
    await expectBootFailure(
      { AI_PROVIDER_ORDER: ' OpenRouter,unknown ' },
      'AI_PROVIDER_ORDER contains invalid providers: unknown',
    );
  });

  it('exits when no provider in the normalized order is configured', async () => {
    await expectBootFailure(
      {
        AI_PROVIDER_ORDER: 'anthropic',
        OPENROUTER_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      'No configured AI providers found in AI_PROVIDER_ORDER',
    );
  });

  it('exits when postgres has neither DATABASE_URL nor every connection field', async () => {
    await expectBootFailure(
      {
        DB_DIALECT: 'postgres',
        DATABASE_URL: undefined,
        POSTGRES_HOST: 'db',
        POSTGRES_DB: undefined,
        POSTGRES_USER: undefined,
        POSTGRES_PASSWORD: undefined,
      },
      'DB_DIALECT=postgres requires DATABASE_URL or POSTGRES_* connection fields',
    );
  });

  it('exits when GITHUB_ISSUES_REPO is not owner/repo', async () => {
    await expectBootFailure(
      { GITHUB_ISSUES_REPO: 'not-a-repo' },
      'GITHUB_ISSUES_REPO must be in the form owner/repo',
    );
  });

  it('exits when Turnstile is enabled without both keys', async () => {
    await expectBootFailure(
      {
        DEMO_TURNSTILE_ENABLED: 'true',
        DEMO_TURNSTILE_SITE_KEY: 'test_site_key',
        DEMO_TURNSTILE_SECRET_KEY: undefined,
      },
      'DEMO_TURNSTILE_ENABLED=true requires DEMO_TURNSTILE_SITE_KEY and DEMO_TURNSTILE_SECRET_KEY',
    );
  });

  it('exits when the enabled AMQP bridge has no broker URL', async () => {
    await expectBootFailure(
      {
        BRIDGE_ENABLED: 'true',
        BRIDGE_TRANSPORT: 'amqp',
        BRIDGE_BROKER_URL: undefined,
      },
      'BRIDGE_TRANSPORT=amqp requires BRIDGE_BROKER_URL when BRIDGE_ENABLED=true',
    );
  });

  it('exits when the enabled HTTP bridge has no monitoring token', async () => {
    await expectBootFailure(
      {
        BRIDGE_ENABLED: 'true',
        BRIDGE_TRANSPORT: 'http',
        MONITORING_TOKEN: undefined,
      },
      'bridge http transport authenticates with MONITORING_TOKEN',
    );
  });

  it('exits when the WhatsApp minimum delay exceeds the maximum', async () => {
    await expectBootFailure(
      {
        WHATSAPP_SAFETY_MIN_DELAY_MS: '2000',
        WHATSAPP_SAFETY_MAX_DELAY_MS: '1000',
      },
      'WHATSAPP_SAFETY_MIN_DELAY_MS must be less than or equal to WHATSAPP_SAFETY_MAX_DELAY_MS',
    );
  });

  it('prints every applicable semantic error before exiting once', async () => {
    await expect(importConfigWithEnv({
      GITHUB_ISSUES_REPO: 'not-a-repo',
      DEMO_TURNSTILE_ENABLED: 'true',
      DEMO_TURNSTILE_SITE_KEY: undefined,
      DEMO_TURNSTILE_SECRET_KEY: undefined,
      WHATSAPP_SAFETY_MIN_DELAY_MS: '2000',
      WHATSAPP_SAFETY_MAX_DELAY_MS: '1000',
    })).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('GITHUB_ISSUES_REPO must be in the form owner/repo'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('DEMO_TURNSTILE_ENABLED=true requires'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('WHATSAPP_SAFETY_MIN_DELAY_MS must be less than or equal to'),
    );
  });

  it('imports the pure parser with no environment variables without throwing or exiting', async () => {
    vi.resetModules();
    process.env = {};

    const modulePromise = import('../src/utils/config/parse-config.js');

    await expect(modulePromise).resolves.toHaveProperty('parseConfig');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('returns structured schema issues and independently-detectable semantic issues together', async () => {
    const { parseConfig } = await import('../src/utils/config/parse-config.js');

    const result = parseConfig({
      MESSAGING_PLATFORM: 'discord',
      LOG_LEVEL: 'loud',
      AI_PROVIDER_ORDER: 'openrouter',
      OPENROUTER_API_KEY: 'test_key_ci',
      BRIDGE_ENABLED: 'true',
      BRIDGE_TRANSPORT: 'amqp',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid config');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ['LOG_LEVEL'],
        source: 'schema',
        severity: 'error',
      }),
      expect.objectContaining({
        code: 'bridge.amqp_broker_required',
        path: ['BRIDGE_BROKER_URL'],
        message: expect.stringContaining('BRIDGE_TRANSPORT=amqp requires BRIDGE_BROKER_URL'),
        source: 'semantic',
        severity: 'error',
      }),
    ]));
  });

  it('prints the RAG filesystem warning before exiting on semantic errors', async () => {
    await expect(importConfigWithEnv({
      RAG_FEDERATION_ENABLED: 'true',
      BRIDGE_ENABLED: 'true',
      BRIDGE_TRANSPORT: 'amqp',
      BRIDGE_BROKER_URL: undefined,
    })).rejects.toThrow('process.exit called');

    expect(warnSpy).toHaveBeenCalledWith(
      '⚠️ RAG_FEDERATION_ENABLED=true but config/rag-sources.json is not readable; federation disabled',
    );
    expect(warnSpy.mock.invocationCallOrder[0]).toBeLessThan(errorSpy.mock.invocationCallOrder[0] ?? Infinity);
  });
});
