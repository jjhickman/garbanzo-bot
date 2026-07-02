import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function context() {
  return {
    groupName: 'General',
    groupJid: 'test@g.us',
    senderJid: 'user@s.whatsapp.net',
  };
}

function installRouterMocks(overrides: {
  isOllamaAvailable?: ReturnType<typeof vi.fn>;
  callOllama?: ReturnType<typeof vi.fn>;
  callClaude?: ReturnType<typeof vi.fn>;
  getDailyCost?: ReturnType<typeof vi.fn>;
} = {}) {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const isOllamaAvailable = overrides.isOllamaAvailable ?? vi.fn(async () => true);
  const callOllama = overrides.callOllama ?? vi.fn(async () => 'local reply');
  const callClaude = overrides.callClaude ?? vi.fn(async () => ({
    provider: 'openrouter',
    model: 'test-model',
    text: 'cloud reply',
  }));
  const getDailyCost = overrides.getDailyCost ?? vi.fn(() => 0);

  vi.doMock('../src/middleware/logger.js', () => ({ logger }));
  vi.doMock('../src/ai/ollama.js', () => ({ isOllamaAvailable, callOllama }));
  vi.doMock('../src/ai/persona.js', () => ({
    buildSystemPrompt: vi.fn(async () => 'system prompt'),
    buildOllamaPrompt: vi.fn(async () => 'ollama prompt'),
  }));
  vi.doMock('../src/ai/claude.js', () => ({ callClaude }));
  vi.doMock('../src/ai/chatgpt.js', () => ({
    callChatGPT: vi.fn(async () => ({ provider: 'openai', model: 'test-model', text: 'openai reply' })),
  }));
  vi.doMock('../src/ai/gemini.js', () => ({
    callGemini: vi.fn(async () => ({ provider: 'gemini', model: 'test-model', text: 'gemini reply' })),
  }));
  vi.doMock('../src/ai/bedrock.js', () => ({
    callBedrock: vi.fn(async () => ({ provider: 'bedrock', model: 'test-model', text: 'bedrock reply' })),
  }));
  vi.doMock('../src/middleware/stats.js', () => ({
    recordAIRoute: vi.fn(),
    recordAICost: vi.fn(),
    recordAIError: vi.fn(),
    estimateClaudeCost: vi.fn(() => ({ model: 'claude', inputTokens: 1, outputTokens: 1, estimatedCost: 0.01, latencyMs: 0 })),
    estimateOpenAICost: vi.fn(() => ({ model: 'openai', inputTokens: 1, outputTokens: 1, estimatedCost: 0.01, latencyMs: 0 })),
    estimateGeminiCost: vi.fn(() => ({ model: 'gemini', inputTokens: 1, outputTokens: 1, estimatedCost: 0.01, latencyMs: 0 })),
    estimateBedrockCost: vi.fn(() => ({ model: 'bedrock', inputTokens: 1, outputTokens: 1, estimatedCost: 0.01, latencyMs: 0 })),
    getDailyCost,
    DAILY_COST_ALERT_THRESHOLD: 1,
  }));

  return { logger, isOllamaAvailable, callOllama, callClaude, getDailyCost };
}

function costAlertWarnings(logger: { warn: ReturnType<typeof vi.fn> }): number {
  return logger.warn.mock.calls.filter((call) => call[1] === 'Daily cost alert threshold reached').length;
}

describe('AI router hardening', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('shares one in-flight Ollama availability probe across concurrent callers', async () => {
    const probe = deferred<boolean>();
    const mocks = installRouterMocks({
      isOllamaAvailable: vi.fn(() => probe.promise),
    });
    const { getAIResponse } = await import('../src/ai/router.js');

    const first = getAIResponse('hey', context());
    const second = getAIResponse('yo', context());

    await vi.waitFor(() => {
      expect(mocks.isOllamaAvailable).toHaveBeenCalledTimes(1);
    });

    probe.resolve(true);

    await expect(Promise.all([first, second])).resolves.toEqual(['local reply', 'local reply']);
    expect(mocks.callOllama).toHaveBeenCalledTimes(2);
  });

  it('reuses the Ollama availability cache until the TTL expires', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-02T12:00:00-04:00') });
    const mocks = installRouterMocks();
    const { getAIResponse } = await import('../src/ai/router.js');

    await getAIResponse('hey', context());
    await getAIResponse('yo', context());
    expect(mocks.isOllamaAvailable).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-07-02T12:01:01-04:00'));
    await getAIResponse('hi', context());
    expect(mocks.isOllamaAvailable).toHaveBeenCalledTimes(2);
  });

  it('dedupes daily cost alerts by local date', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-02T12:00:00-04:00') });
    const mocks = installRouterMocks({
      getDailyCost: vi.fn(() => 1.25),
    });
    const { getAIResponse } = await import('../src/ai/router.js');

    await getAIResponse('explain the difference between ales and lagers', context());
    await getAIResponse('compare the red line versus the orange line', context());

    expect(costAlertWarnings(mocks.logger)).toBe(1);

    vi.setSystemTime(new Date('2026-07-03T12:00:00-04:00'));
    await getAIResponse('however I think the old system was better', context());

    expect(costAlertWarnings(mocks.logger)).toBe(2);
  });
});
