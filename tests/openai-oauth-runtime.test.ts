// AI-layer test: runs under the standard test env prefix.
import { afterEach, describe, expect, it, vi } from 'vitest';

const oauth = vi.hoisted(() => ({ getOpenAIAccessToken: vi.fn() }));
vi.mock('../src/ai/openai-oauth.js', () => ({ getOpenAIAccessToken: oauth.getOpenAIAccessToken }));

import { callChatGPT } from '../src/ai/chatgpt.js';
import { __resetCloudBreakers } from '../src/ai/cloud-call.js';
import { config } from '../src/utils/config.js';

const original = {
  mode: config.OPENAI_AUTH_MODE,
  key: config.OPENAI_API_KEY,
  model: config.OPENAI_MODEL,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function lastFetchInit(spy: ReturnType<typeof vi.spyOn>): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const call = spy.mock.calls[0] as unknown as [string, RequestInit];
  return {
    url: call[0],
    headers: call[1].headers as Record<string, string>,
    body: JSON.parse(call[1].body as string) as Record<string, unknown>,
  };
}

describe('callChatGPT auth modes', () => {
  afterEach(() => {
    config.OPENAI_AUTH_MODE = original.mode;
    config.OPENAI_API_KEY = original.key;
    config.OPENAI_MODEL = original.model;
    __resetCloudBreakers();
    oauth.getOpenAIAccessToken.mockReset();
    vi.restoreAllMocks();
  });

  it('oauth mode calls the ChatGPT Responses backend with the bearer + account header', async () => {
    config.OPENAI_AUTH_MODE = 'oauth';
    config.OPENAI_MODEL = 'gpt-5';
    oauth.getOpenAIAccessToken.mockResolvedValue({ accessToken: 'tok-123', accountId: 'acc-9' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi from ChatGPT' }] }] }),
    );

    const out = await callChatGPT('system prompt', 'hello');
    expect(out).toEqual({ text: 'Hi from ChatGPT', provider: 'openai', model: 'gpt-5' });

    const req = lastFetchInit(fetchSpy);
    expect(req.url).toBe('https://chatgpt.com/backend-api/wham/responses');
    expect(req.headers.authorization).toBe('Bearer tok-123');
    expect(req.headers['chatgpt-account-id']).toBe('acc-9');
    expect(req.body.store).toBe(false);
    expect(req.body.instructions).toBe('system prompt');
    const input = req.body.input as Array<{ content: Array<{ type: string; text?: string }> }>;
    expect(input[0]?.content.at(-1)).toEqual({ type: 'input_text', text: 'hello' });
  });

  it('oauth mode surfaces a backend error so the router falls over', async () => {
    config.OPENAI_AUTH_MODE = 'oauth';
    oauth.getOpenAIAccessToken.mockResolvedValue({ accessToken: 't', accountId: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));

    await expect(callChatGPT('s', 'u')).rejects.toThrow(/openai API error 401/);
  });

  it('oauth mode surfaces a not-logged-in error so the router falls over', async () => {
    config.OPENAI_AUTH_MODE = 'oauth';
    oauth.getOpenAIAccessToken.mockRejectedValue(new Error('OpenAI OAuth is not logged in (run: npm run openai:login)'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(callChatGPT('s', 'u')).rejects.toThrow(/not logged in/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('oauth mode throws on a malformed HTTP-200 payload so the router falls over', async () => {
    config.OPENAI_AUTH_MODE = 'oauth';
    oauth.getOpenAIAccessToken.mockResolvedValue({ accessToken: 't', accountId: null });
    // HTTP 200 but the body does not match the Responses schema (backend error / shape drift).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'temporarily_unavailable' }));

    await expect(callChatGPT('s', 'u')).rejects.toThrow(/did not match expected shape/);
  });

  it('apikey mode is unchanged (chat/completions, no OAuth token fetch)', async () => {
    config.OPENAI_AUTH_MODE = 'apikey';
    config.OPENAI_API_KEY = 'sk-test';
    config.OPENAI_MODEL = 'gpt-4.1';

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'apikey reply' } }] }),
    );

    const out = await callChatGPT('sys', 'hi');
    expect(out.text).toBe('apikey reply');
    expect(lastFetchInit(fetchSpy).url).toBe('https://api.openai.com/v1/chat/completions');
    expect(oauth.getOpenAIAccessToken).not.toHaveBeenCalled();
  });
});
