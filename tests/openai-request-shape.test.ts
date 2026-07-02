process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, describe, expect, it } from 'vitest';

const { buildProviderRequest, isOpenAiReasoningModel } = await import('../src/ai/cloud-providers.js');
const { config } = await import('../src/utils/config.js');

function build(provider: 'openai' | 'openrouter') {
  const req = buildProviderRequest(provider, 'sys', 'hello');
  if (!req) throw new Error(`expected ${provider} request to be built`);
  return req;
}

const original = {
  key: config.OPENAI_API_KEY,
  model: config.OPENAI_MODEL,
  effort: config.OPENAI_REASONING_EFFORT,
  routerKey: config.OPENROUTER_API_KEY,
};

describe('OpenAI reasoning-model request shape', () => {
  afterEach(() => {
    config.OPENAI_API_KEY = original.key;
    config.OPENAI_MODEL = original.model;
    config.OPENAI_REASONING_EFFORT = original.effort;
    config.OPENROUTER_API_KEY = original.routerKey;
  });

  it('classifies models correctly', () => {
    expect(isOpenAiReasoningModel('gpt-5.4')).toBe(true);
    expect(isOpenAiReasoningModel('gpt-5.4-mini')).toBe(true);
    expect(isOpenAiReasoningModel('gpt-5.4-nano')).toBe(true);
    expect(isOpenAiReasoningModel('o3-mini')).toBe(true);
    expect(isOpenAiReasoningModel('gpt-4.1')).toBe(false);
    expect(isOpenAiReasoningModel('gpt-4o')).toBe(false);
  });

  it('sends max_completion_tokens + reasoning_effort for GPT-5-series', () => {
    config.OPENAI_API_KEY = 'sk-test';
    config.OPENAI_MODEL = 'gpt-5.4';
    config.OPENAI_REASONING_EFFORT = 'low';

    const req = build('openai');
    expect(req.body.max_completion_tokens).toBe(config.CLOUD_MAX_TOKENS);
    expect(req.body.reasoning_effort).toBe('low');
    expect(req.body.max_tokens).toBeUndefined();
  });

  it('keeps max_tokens for pre-reasoning OpenAI models', () => {
    config.OPENAI_API_KEY = 'sk-test';
    config.OPENAI_MODEL = 'gpt-4.1';

    const req = build('openai');
    expect(req.body.max_tokens).toBe(config.CLOUD_MAX_TOKENS);
    expect(req.body.max_completion_tokens).toBeUndefined();
    expect(req.body.reasoning_effort).toBeUndefined();
  });

  it('honors OPENAI_REASONING_EFFORT overrides', () => {
    config.OPENAI_API_KEY = 'sk-test';
    config.OPENAI_MODEL = 'gpt-5.4-mini';
    config.OPENAI_REASONING_EFFORT = 'minimal';

    const req = build('openai');
    expect(req.body.reasoning_effort).toBe('minimal');
  });

  it('leaves the OpenRouter path on max_tokens regardless of model name', () => {
    config.OPENROUTER_API_KEY = 'or-test';

    const req = build('openrouter');
    expect(req.body.max_tokens).toBe(config.CLOUD_MAX_TOKENS);
    expect(req.body.max_completion_tokens).toBeUndefined();
  });
});
