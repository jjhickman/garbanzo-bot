process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ProviderRequest } from '../src/ai/cloud-providers.js';
import type { AiTool } from '../src/ai/tools.js';

type ChatGptModule = typeof import('../src/ai/chatgpt.js');
type CloudCallModule = typeof import('../src/ai/cloud-call.js');
type CloudProvidersModule = typeof import('../src/ai/cloud-providers.js');
type ToolLoopModule = typeof import('../src/ai/tool-loop.js');
type ConfigModule = typeof import('../src/utils/config.js');

let callChatGPT: ChatGptModule['callChatGPT'];
let __resetCloudBreakers: CloudCallModule['__resetCloudBreakers'];
let buildProviderRequest: CloudProvidersModule['buildProviderRequest'];
let runAnthropicToolLoop: ToolLoopModule['runAnthropicToolLoop'];
let runOpenAiCompatToolLoop: ToolLoopModule['runOpenAiCompatToolLoop'];
let config: ConfigModule['config'];
let original: {
  anthropicKey: string | undefined;
  anthropicModel: string;
  openaiKey: string | undefined;
  openaiModel: string;
  openaiMode: 'apikey' | 'oauth';
  toolCalling: boolean;
  toolIterations: number;
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestBodies(fetchSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return fetchSpy.mock.calls.map((call) => {
    const init = call[1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  });
}

function stringTool(name: string, execute: (input: Record<string, unknown>) => Promise<string>): AiTool {
  return {
    name,
    description: `${name} description`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
    execute,
  };
}

function expectProviderRequest(req: ProviderRequest | null): ProviderRequest {
  expect(req).not.toBeNull();
  return req as ProviderRequest;
}

describe('LLM tool loops', () => {
  beforeAll(async () => {
    ({ callChatGPT } = await import('../src/ai/chatgpt.js'));
    ({ __resetCloudBreakers } = await import('../src/ai/cloud-call.js'));
    ({ buildProviderRequest } = await import('../src/ai/cloud-providers.js'));
    ({ runAnthropicToolLoop, runOpenAiCompatToolLoop } = await import('../src/ai/tool-loop.js'));
    ({ config } = await import('../src/utils/config.js'));
    original = {
      anthropicKey: config.ANTHROPIC_API_KEY,
      anthropicModel: config.ANTHROPIC_MODEL,
      openaiKey: config.OPENAI_API_KEY,
      openaiModel: config.OPENAI_MODEL,
      openaiMode: config.OPENAI_AUTH_MODE,
      toolCalling: config.AI_TOOL_CALLING,
      toolIterations: config.AI_TOOL_MAX_ITERATIONS,
    };
  });

  afterEach(() => {
    config.ANTHROPIC_API_KEY = original.anthropicKey;
    config.ANTHROPIC_MODEL = original.anthropicModel;
    config.OPENAI_API_KEY = original.openaiKey;
    config.OPENAI_MODEL = original.openaiModel;
    config.OPENAI_AUTH_MODE = original.openaiMode;
    config.AI_TOOL_CALLING = original.toolCalling;
    config.AI_TOOL_MAX_ITERATIONS = original.toolIterations;
    __resetCloudBreakers();
    vi.restoreAllMocks();
  });

  it('runs an Anthropic tool_use round trip and returns the final text', async () => {
    config.ANTHROPIC_API_KEY = 'test_anthropic_key';
    config.ANTHROPIC_MODEL = 'claude-test';
    const execute = vi.fn(async () => 'Weather: 72F and clear');
    const tools = [stringTool('get_weather', execute)];
    const req = expectProviderRequest(
      buildProviderRequest('anthropic', 'system prompt', 'weather tomorrow', undefined, tools),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { query: 'forecast tomorrow somerville' } },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        content: [{ type: 'text', text: 'Final: 72F and clear tomorrow.' }],
      }));

    const text = await runAnthropicToolLoop(req, tools, new AbortController().signal);

    expect(text).toBe('Final: 72F and clear tomorrow.');
    expect(execute).toHaveBeenCalledWith({ query: 'forecast tomorrow somerville' });
    const [, secondBody] = requestBodies(fetchSpy);
    expect(secondBody.messages).toEqual([
      { role: 'user', content: 'weather tomorrow' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { query: 'forecast tomorrow somerville' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Weather: 72F and clear' }],
      },
    ]);
  });

  it('runs an OpenAI-compatible tool_calls round trip', async () => {
    config.OPENAI_API_KEY = 'sk-test';
    config.OPENAI_MODEL = 'gpt-test';
    const execute = vi.fn(async () => 'Red Line has normal service');
    const tools = [stringTool('get_transit_status', execute)];
    const req = expectProviderRequest(
      buildProviderRequest('openai', 'system prompt', 'is the red line running?', undefined, tools),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_transit_status', arguments: '{"query":"red line status"}' },
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: 'The Red Line is running normally.' } }],
      }));

    const text = await runOpenAiCompatToolLoop(req, tools, new AbortController().signal);

    expect(text).toBe('The Red Line is running normally.');
    expect(execute).toHaveBeenCalledWith({ query: 'red line status' });
    const [, secondBody] = requestBodies(fetchSpy);
    expect(secondBody.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'is the red line running?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_transit_status', arguments: '{"query":"red line status"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Red Line has normal service' },
    ]);
  });

  it('executes multiple OpenAI-compatible tool calls from one model turn', async () => {
    config.OPENAI_API_KEY = 'sk-test';
    const weather = vi.fn(async () => 'Weather result');
    const transit = vi.fn(async () => 'Transit result');
    const tools = [
      stringTool('get_weather', weather),
      stringTool('get_transit_status', transit),
    ];
    const req = expectProviderRequest(
      buildProviderRequest('openrouter', 'system', 'plan my commute', undefined, tools),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        choices: [{
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_weather',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"query":"somerville now"}' },
              },
              {
                id: 'call_transit',
                type: 'function',
                function: { name: 'get_transit_status', arguments: '{"query":"orange line"}' },
              },
            ],
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: 'Bring an umbrella and take the Orange Line.' } }],
      }));

    const text = await runOpenAiCompatToolLoop(req, tools, new AbortController().signal);

    expect(text).toBe('Bring an umbrella and take the Orange Line.');
    expect(weather).toHaveBeenCalledWith({ query: 'somerville now' });
    expect(transit).toHaveBeenCalledWith({ query: 'orange line' });
    const [, secondBody] = requestBodies(fetchSpy);
    const messages = secondBody.messages as Array<Record<string, unknown>>;
    expect(messages.at(-2)).toEqual({ role: 'tool', tool_call_id: 'call_weather', content: 'Weather result' });
    expect(messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_transit', content: 'Transit result' });
  });

  it('uses tool_choice none on the final OpenAI-compatible turn after the iteration cap', async () => {
    config.OPENAI_API_KEY = 'sk-test';
    const tools = [stringTool('get_weather', async () => 'Weather result')];
    const req = expectProviderRequest(
      buildProviderRequest('openai', 'system', 'weather loop', undefined, tools),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"query":"boston"}' },
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: 'Forced final answer.' } }],
      }));

    const text = await runOpenAiCompatToolLoop(req, tools, new AbortController().signal, 1);

    expect(text).toBe('Forced final answer.');
    const [, finalBody] = requestBodies(fetchSpy);
    expect(finalBody.tool_choice).toBe('none');
  });

  it('sends tool execution errors as tool results and still returns a reply', async () => {
    config.OPENAI_API_KEY = 'sk-test';
    const tools = [stringTool('get_news', async () => {
      throw new Error('upstream timeout');
    })];
    const req = expectProviderRequest(
      buildProviderRequest('openai', 'system', 'news?', undefined, tools),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_news',
              type: 'function',
              function: { name: 'get_news', arguments: '{"query":"boston"}' },
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: 'I could not check news, but here is what I can say.' } }],
      }));

    const text = await runOpenAiCompatToolLoop(req, tools, new AbortController().signal);

    expect(text).toBe('I could not check news, but here is what I can say.');
    const [, secondBody] = requestBodies(fetchSpy);
    const messages = secondBody.messages as Array<Record<string, unknown>>;
    expect(messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_news',
      content: 'Tool get_news failed: upstream timeout',
    });
  });

  it('leaves the single-shot OpenAI request tool-free when the flag is off', async () => {
    config.AI_TOOL_CALLING = false;
    config.OPENAI_AUTH_MODE = 'apikey';
    config.OPENAI_API_KEY = 'sk-test';

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'plain reply' } }] }),
    );

    const response = await callChatGPT('system prompt', 'hello');

    expect(response.text).toBe('plain reply');
    const [body] = requestBodies(fetchSpy);
    expect(body).not.toHaveProperty('tools');
  });
});
