import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProviderRequest } from '../src/ai/cloud-providers.js';
import { callGemini } from '../src/ai/gemini.js';
import { config } from '../src/utils/config.js';

const originalGeminiApiKey = config.GEMINI_API_KEY;
const originalGeminiModel = config.GEMINI_MODEL;

afterEach(() => {
  config.GEMINI_API_KEY = originalGeminiApiKey;
  config.GEMINI_MODEL = originalGeminiModel;
  vi.restoreAllMocks();
});

describe('Gemini integration', () => {
  it('builds a Gemini provider request for text prompts', () => {
    config.GEMINI_API_KEY = 'test-key';
    config.GEMINI_MODEL = 'gemini-1.5-flash';

    const req = buildProviderRequest('gemini', 'system prompt', 'hello world');
    expect(req).not.toBeNull();

    if (!req) throw new Error('Expected Gemini provider request');
    const safeReq = req;
    expect(safeReq.provider).toBe('gemini');
    expect(safeReq.model).toBe('gemini-1.5-flash');
    expect(safeReq.endpoint).toContain('generativelanguage.googleapis.com');
    expect(safeReq.endpoint).toContain('test-key');

    const body = safeReq.body as {
      systemInstruction: { parts: Array<{ text?: string }> };
      contents: Array<{ parts: Array<{ text?: string }> }>;
    };

    expect(body.systemInstruction.parts[0]?.text).toBe('system prompt');
    expect(body.contents[0]?.parts[0]?.text).toBe('hello world');
  });

  it('adds inlineData parts for vision images', () => {
    config.GEMINI_API_KEY = 'test-key';

    const req = buildProviderRequest('gemini', 'sys', 'what is this?', [{
      mediaType: 'image/png',
      base64: 'ZmFrZQ==',
    }]);

    expect(req).not.toBeNull();

    if (!req) throw new Error('Expected Gemini provider request');

    const body = req.body as {
      contents: Array<{
        parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
      }>;
    };

    const parts = body.contents[0]?.parts ?? [];
    expect(parts[0]?.inlineData?.mimeType).toBe('image/png');
    expect(parts[0]?.inlineData?.data).toBe('ZmFrZQ==');
    expect(parts[1]?.text).toBe('what is this?');
  });

  it('parses Gemini responses end-to-end via callGemini', async () => {
    config.GEMINI_API_KEY = 'test-key';
    config.GEMINI_MODEL = 'gemini-1.5-flash';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{
            content: {
              parts: [{ text: 'Hello' }, { text: ' from Gemini' }],
            },
          }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const out = await callGemini('system', 'user');
    expect(out.provider).toBe('gemini');
    expect(out.model).toBe('gemini-1.5-flash');
    expect(out.text).toBe('Hello from Gemini');
  });

  it('throws a clear error when Gemini API fails', async () => {
    config.GEMINI_API_KEY = 'test-key';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('upstream failure', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    await expect(callGemini('system', 'user')).rejects.toThrow('gemini API error 500');
  });
});
