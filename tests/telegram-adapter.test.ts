import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTelegramAdapter } from '../src/platforms/telegram/adapter.js';
import { createMessageRef } from '../src/core/message-ref.js';

const TOKEN = 'test-bot-token';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

describe('Telegram adapter — sendText / MarkdownV2', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends MarkdownV2 with parse_mode set', async () => {
    const calls: CapturedCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true, result: { message_id: 42 } });
    }));

    const adapter = createTelegramAdapter(TOKEN);
    await adapter.sendText('chat-1', 'Hello *world*!');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.parse_mode).toBe('MarkdownV2');
    expect(body.text).toBe('Hello *world*\\!');

    vi.unstubAllGlobals();
  });

  it('includes reply_to_message_id for a telegram MessageRef', async () => {
    const calls: CapturedCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true, result: { message_id: 43 } });
    }));

    const adapter = createTelegramAdapter(TOKEN);
    const replyTo = createMessageRef({ platform: 'telegram', chatId: 'chat-1', id: '999', ref: {} });
    await adapter.sendText('chat-1', 'reply text', { replyTo });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.reply_to_message_id).toBe(999);

    vi.unstubAllGlobals();
  });

  it('retries once as plain text on a MarkdownV2 parse-entities 400 error', async () => {
    const calls: CapturedCall[] = [];
    let attempt = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse({
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse entities: Character '.' is reserved",
        });
      }
      return jsonResponse({ ok: true, result: { message_id: 44 } });
    }));

    const adapter = createTelegramAdapter(TOKEN);
    await adapter.sendText('chat-1', 'some text');

    expect(calls).toHaveLength(2);
    const secondBody = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
    expect(secondBody.parse_mode).toBeUndefined();
    expect(secondBody.text).toBe('some text');

    vi.unstubAllGlobals();
  });

  it('does not retry-as-plain-text for a non-parse-entities 400 error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    })));

    const adapter = createTelegramAdapter(TOKEN);
    await expect(adapter.sendText('chat-1', 'text')).rejects.toThrow(/chat not found/);

    vi.unstubAllGlobals();
  });

  it('respects 429 retry_after with a single retry', async () => {
    vi.useFakeTimers();
    const calls: CapturedCall[] = [];
    let attempt = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 2',
          parameters: { retry_after: 2 },
        });
      }
      return jsonResponse({ ok: true, result: { message_id: 45 } });
    }));

    const adapter = createTelegramAdapter(TOKEN);
    const sendPromise = adapter.sendText('chat-1', 'rate limited text');

    await vi.advanceTimersByTimeAsync(2000);
    await sendPromise;

    expect(calls).toHaveLength(2);

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('throws after a second 429 (single-retry only, not infinite)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 1 },
    })));

    const adapter = createTelegramAdapter(TOKEN);
    const sendPromise = adapter.sendText('chat-1', 'still limited').catch((err: Error) => err);

    await vi.advanceTimersByTimeAsync(1000);
    const result = await sendPromise;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/429/);

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});

describe('Telegram adapter — document / audio / delete', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a document as multipart form data and returns a ref', async () => {
    const calls: CapturedCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true, result: { message_id: 50 } });
    }));

    const adapter = createTelegramAdapter(TOKEN);
    const ref = await adapter.sendDocument('chat-1', {
      bytes: new Uint8Array([1, 2, 3]),
      mimetype: 'application/pdf',
      fileName: 'sheet.pdf',
    });

    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendDocument`);
    expect(calls[0]?.init.body).toBeInstanceOf(FormData);
    expect(ref.id).toBe('50');
    expect(ref.platform).toBe('telegram');

    vi.unstubAllGlobals();
  });

  it('sends a voice note via sendVoice when ptt is true', async () => {
    const calls: CapturedCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true, result: { message_id: 51 } });
    }));

    const adapter = createTelegramAdapter(TOKEN);
    await adapter.sendAudio('chat-1', { bytes: new Uint8Array([1]), mimetype: 'audio/ogg', ptt: true });

    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendVoice`);

    vi.unstubAllGlobals();
  });

  it('sends a regular audio file via sendAudio when ptt is false', async () => {
    const calls: CapturedCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true, result: { message_id: 52 } });
    }));

    const adapter = createTelegramAdapter(TOKEN);
    await adapter.sendAudio('chat-1', { bytes: new Uint8Array([1]), mimetype: 'audio/mpeg', ptt: false });

    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendAudio`);

    vi.unstubAllGlobals();
  });

  it('deletes a message by numeric id', async () => {
    const calls: CapturedCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true, result: true });
    }));

    const adapter = createTelegramAdapter(TOKEN);
    const ref = createMessageRef({ platform: 'telegram', chatId: 'chat-1', id: '77', ref: {} });
    await adapter.deleteMessage('chat-1', ref);

    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/deleteMessage`);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ chat_id: 'chat-1', message_id: 77 });

    vi.unstubAllGlobals();
  });

  it('never calls the network directly — every send goes through the stubbed fetch', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal('fetch', fetchSpy);

    const adapter = createTelegramAdapter(TOKEN);
    await adapter.sendText('chat-1', 'hi');
    await adapter.sendPoll('chat-1', { name: 'Poll', values: ['a', 'b'], selectableCount: 1 });

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });
});
