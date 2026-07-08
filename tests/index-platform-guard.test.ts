process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import type { IncomingMessage, ServerResponse } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MessagingPlatform } from '../src/core/messaging-platform.js';
import { shouldEnableWhatsAppLogin } from '../src/platforms/whatsapp/login-url.js';

type WhatsAppLoginMode = 'web' | 'terminal' | 'both';
type LoginHandler = (req: IncomingMessage, res: ServerResponse) => boolean;

interface IndexConfigOverrides {
  MONITORING_TOKEN?: string;
  WHATSAPP_LOGIN_TOKEN?: string;
  MESSAGING_PLATFORM?: MessagingPlatform;
  METRICS_ENABLED?: boolean;
  ADMIN_PAGE_ENABLED?: boolean;
  WHATSAPP_LOGIN_MODE?: WhatsAppLoginMode;
}

async function importIndexWithMocks(overrides: IndexConfigOverrides = {}): Promise<{
  startHealthServer: ReturnType<typeof vi.fn>;
  createLoginRequestHandler: ReturnType<typeof vi.fn>;
  loginHandler: LoginHandler;
  loggerInfo: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  process.env.HEALTH_ONLY = 'false';

  const startHealthServer = vi.fn();
  const createLoginRequestHandler = vi.fn();
  const loginHandler: LoginHandler = () => true;
  const loggerInfo = vi.fn();
  const loggerFatal = vi.fn();

  createLoginRequestHandler.mockReturnValue(loginHandler);
  vi.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

  vi.doMock('../src/utils/config.js', () => ({
    loadedEnvFiles: ['/tmp/test/.env', '/tmp/test/.env.whatsapp'],
    config: {
      OPENROUTER_API_KEY: 'test_key_ci',
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      BEDROCK_MODEL_ID: undefined,
      MESSAGING_PLATFORM: overrides.MESSAGING_PLATFORM ?? 'whatsapp',
      HEALTH_PORT: 3001,
      HEALTH_BIND_HOST: '127.0.0.1',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      LOG_LEVEL: 'info',
      WHATSAPP_LOGIN_MODE: overrides.WHATSAPP_LOGIN_MODE ?? 'web',
      WHATSAPP_LOGIN_TOKEN: overrides.WHATSAPP_LOGIN_TOKEN,
      MONITORING_TOKEN: overrides.MONITORING_TOKEN,
      METRICS_ENABLED: overrides.METRICS_ENABLED ?? true,
      ADMIN_PAGE_ENABLED: overrides.ADMIN_PAGE_ENABLED ?? true,
    },
  }));

  vi.doMock('../src/middleware/health.js', () => ({
    startHealthServer,
    stopHealthServer: vi.fn(),
    startMemoryWatchdog: vi.fn(),
  }));

  vi.doMock('../src/platforms/whatsapp/login-server.js', () => ({
    createLoginRequestHandler,
  }));

  vi.doMock('../src/platforms/whatsapp/login-url.js', () => ({
    shouldEnableWhatsAppLogin: vi.fn((
      platform: MessagingPlatform,
      loginMode: WhatsAppLoginMode,
      healthOnlyMode: boolean,
    ) => platform === 'whatsapp' && !healthOnlyMode && (loginMode === 'web' || loginMode === 'both')),
    resolveLoginHosts: vi.fn(() => ['127.0.0.1']),
    isNetworkExposedHost: vi.fn(() => false),
  }));

  vi.doMock('../src/platforms/index.js', () => ({
    getPlatformRuntime: vi.fn(() => ({
      platform: overrides.MESSAGING_PLATFORM ?? 'whatsapp',
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    })),
  }));

  vi.doMock('../src/middleware/logger.js', () => ({
    logger: {
      info: loggerInfo,
      warn: vi.fn(),
      error: vi.fn(),
      fatal: loggerFatal,
    },
  }));

  vi.doMock('../src/utils/db.js', () => ({
    closeDb: vi.fn(async () => undefined),
    scheduleMaintenance: vi.fn(),
  }));

  vi.doMock('../src/middleware/retry.js', () => ({
    clearRetryQueue: vi.fn(),
  }));

  vi.doMock('../src/ai/ollama.js', () => ({
    startOllamaWarmup: vi.fn(),
    stopOllamaWarmup: vi.fn(),
  }));

  vi.doMock('../src/ai/persona.js', () => ({
    getPersonaName: vi.fn(() => 'Test Persona'),
  }));

  await import('../src/index.js');
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  if (loggerFatal.mock.calls.length > 0) {
    const firstArg = loggerFatal.mock.calls[0]?.[0] as { err?: unknown } | undefined;
    throw firstArg?.err instanceof Error ? firstArg.err : new Error('Index import logged a fatal error');
  }

  return {
    startHealthServer,
    createLoginRequestHandler,
    loginHandler,
    loggerInfo,
  };
}

describe('shouldEnableWhatsAppLogin', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../src/utils/config.js');
    vi.doUnmock('../src/middleware/health.js');
    vi.doUnmock('../src/platforms/whatsapp/login-server.js');
    vi.doUnmock('../src/platforms/whatsapp/login-url.js');
    vi.doUnmock('../src/platforms/index.js');
    vi.doUnmock('../src/middleware/logger.js');
    vi.doUnmock('../src/utils/db.js');
    vi.doUnmock('../src/middleware/retry.js');
    vi.doUnmock('../src/ai/ollama.js');
    vi.doUnmock('../src/ai/persona.js');
    delete process.env.HEALTH_ONLY;
    vi.restoreAllMocks();
  });

  it.each([
    ['whatsapp', 'web', false, true],
    ['whatsapp', 'both', false, true],
    ['whatsapp', 'terminal', false, false],
    ['whatsapp', 'web', true, false],
    ['discord', 'web', false, false],
    ['discord', 'both', false, false],
    ['slack', 'web', false, false],
    ['telegram', 'web', false, false],
    ['matrix', 'web', false, false],
  ] satisfies Array<[MessagingPlatform, WhatsAppLoginMode, boolean, boolean]>)(
    'platform=%s loginMode=%s healthOnlyMode=%s -> %s',
    (platform, loginMode, healthOnlyMode, expected) => {
      expect(shouldEnableWhatsAppLogin(platform, loginMode, healthOnlyMode)).toBe(expected);
    },
  );

  it('passes MONITORING_TOKEN to the health server and WHATSAPP_LOGIN_TOKEN to the login handler', async () => {
    const { startHealthServer, createLoginRequestHandler, loginHandler } = await importIndexWithMocks({
      MONITORING_TOKEN: 'ops-token',
      WHATSAPP_LOGIN_TOKEN: 'login-token',
    });

    expect(createLoginRequestHandler).toHaveBeenCalledWith({ token: 'login-token' });
    expect(startHealthServer).toHaveBeenCalledWith(
      3001,
      '127.0.0.1',
      expect.objectContaining({
        metricsEnabled: true,
        adminEnabled: true,
        authToken: 'ops-token',
        extraHandler: loginHandler,
      }),
    );
  });

  it('logs when ops endpoints are gated by a generated per-run token', async () => {
    const { startHealthServer, loggerInfo } = await importIndexWithMocks({
      WHATSAPP_LOGIN_TOKEN: 'login-token',
      METRICS_ENABLED: true,
      ADMIN_PAGE_ENABLED: false,
    });

    const options = startHealthServer.mock.calls[0]?.[2] as { authToken?: string } | undefined;
    expect(options?.authToken).toBeDefined();
    expect(options?.authToken).not.toBe('login-token');
    expect(loggerInfo).toHaveBeenCalledWith(
      'Ops endpoints are gated by a per-run token; pin MONITORING_TOKEN in .env to enable scraping/admin access.',
    );
  });
});
