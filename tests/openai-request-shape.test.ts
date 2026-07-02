process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, describe, expect, it } from 'vitest';

const { buildProviderRequest, isOpenAiReasoningModel } = await import('../src/ai/cloud-providers.js');
const { config } = await import('../src/utils/config.js');

function build(
  provider: 'openai' | 'openrouter',
  tools?: Parameters<typeof buildProviderRequest>[4],
  visionImages?: Parameters<typeof buildProviderRequest>[3],
) {
  const req = buildProviderRequest(provider, 'sys', 'hello', visionImages, tools);
  if (!req) throw new Error(`expected ${provider} request to be built`);
  return req;
}

const dummyTool = {
  name: 'get_weather',
  description: 'd',
  parameters: { type: 'object' as const, properties: {}, required: [] },
  execute: async () => 'ok',
};

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

  it('uses the Responses API with max_output_tokens + reasoning.effort for GPT-5-series', () => {
    config.OPENAI_API_KEY = 'sk-test';
    config.OPENAI_MODEL = 'gpt-5.4';
    config.OPENAI_REASONING_EFFORT = 'low';

    const req = build('openai');
    expect(req.endpoint).toBe('https://api.openai.com/v1/responses');
    expect(req.body).toMatchObject({
      model: 'gpt-5.4',
      instructions: 'sys',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      max_output_tokens: config.CLOUD_MAX_TOKENS,
      reasoning: { effort: 'low' },
      store: false,
    });
    expect(req.body.max_completion_tokens).toBeUndefined();
    expect(req.body.max_tokens).toBeUndefined();
    expect(req.body.reasoning_effort).toBeUndefined();
    expect(req.body.messages).toBeUndefined();
  });

  it('keeps chat/completions max_tokens for pre-reasoning OpenAI models', () => {
    config.OPENAI_API_KEY = 'sk-test';
    config.OPENAI_MODEL = 'gpt-4.1';

    const req = build('openai');
    expect(req.endpoint).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
    expect(req.body.max_tokens).toBe(config.CLOUD_MAX_TOKENS);
    expect(req.body.max_completion_tokens).toBeUndefined();
    expect(req.body.reasoning_effort).toBeUndefined();
    expect(req.body.max_output_tokens).toBeUndefined();
    expect(req.body.reasoning).toBeUndefined();
  });

  it('honors OPENAI_REASONING_EFFORT overrides', () => {
    config.OPENAI_API_KEY = 'sk-test';
    config.OPENAI_MODEL = 'gpt-5.4-mini';
    config.OPENAI_REASONING_EFFORT = 'minimal';

    const req = build('openai');
    expect(req.body.reasoning).toEqual({ effort: 'minimal' });
  });

  it('flattens function tools on GPT-5 Responses API requests', () => {
    config.OPENAI_API_KEY = 'sk-test';
    config.OPENAI_MODEL = 'gpt-5.4-mini';

    const req = build('openai', [dummyTool]);
    expect(req.endpoint).toBe('https://api.openai.com/v1/responses');
    expect(req.body.max_output_tokens).toBe(config.CLOUD_MAX_TOKENS);
    expect(req.body.reasoning).toEqual({ effort: config.OPENAI_REASONING_EFFORT });
    expect(req.body.tools).toEqual([{
      type: 'function',
      name: 'get_weather',
      description: 'd',
      parameters: { type: 'object', properties: {}, required: [] },
    }]);
  });

  it('maps GPT-5 vision inputs to Responses API input_image blocks', () => {
    config.OPENAI_API_KEY = 'sk-test';
    config.OPENAI_MODEL = 'gpt-5.4-mini';

    const req = build('openai', undefined, [{ mediaType: 'image/png', base64: 'abc123' }]);
    expect(req.body.input).toEqual([{
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'data:image/png;base64,abc123' },
        { type: 'input_text', text: 'hello' },
      ],
    }]);
  });

  it('leaves the OpenRouter path on max_tokens regardless of model name', () => {
    config.OPENROUTER_API_KEY = 'or-test';

    const req = build('openrouter');
    expect(req.endpoint).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(req.body.max_tokens).toBe(config.CLOUD_MAX_TOKENS);
    expect(req.body.max_completion_tokens).toBeUndefined();
    expect(req.body.max_output_tokens).toBeUndefined();
    expect(req.body.reasoning).toBeUndefined();
  });
});
