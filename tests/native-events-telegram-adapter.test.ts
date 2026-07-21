import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTelegramAdapter } from '../src/platforms/telegram/adapter.js';
import { parseTelegramEventRef } from '../src/platforms/telegram/native-events.js';
import type { NativeEventPayload, PlatformMessenger } from '../src/core/platform-messenger.js';

/** Narrow the optional seam methods once — the adapter is expected to have them. */
function nativeEvents(adapter: PlatformMessenger): {
  create: (chatId: string, event: NativeEventPayload) => Promise<string>;
  update: (chatId: string, ref: string, event: NativeEventPayload) => Promise<string>;
  cancel: (chatId: string, ref: string, event: NativeEventPayload) => Promise<void>;
} {
  const { createNativeEvent, updateNativeEvent, cancelNativeEvent } = adapter;
  if (!createNativeEvent || !updateNativeEvent || !cancelNativeEvent) {
    throw new Error('adapter is missing native-event methods');
  }
  return { create: createNativeEvent, update: updateNativeEvent, cancel: cancelNativeEvent };
}

const TOKEN = 'test-bot-token';

// Tue Jul 21 2026 7:00pm–9:00pm local
const START_AT_MS = new Date(2026, 6, 21, 19, 0, 0, 0).getTime();
const END_AT_MS = new Date(2026, 6, 21, 21, 0, 0, 0).getTime();

const EVENT: NativeEventPayload = {
  name: 'Band Practice',
  description: 'Bring the new songs',
  startAtMs: START_AT_MS,
  endAtMs: END_AT_MS,
  location: 'The Garage',
};

interface CapturedCall {
  method: string;
  body: Record<string, unknown>;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Stub fetch with per-method Telegram API responses; captures JSON bodies. */
function stubTelegramApi(
  respond: (method: string, body: Record<string, unknown>) => unknown,
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = url.split('/').pop() ?? '';
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ method, body });
    return jsonResponse(respond(method, body));
  }));
  return calls;
}

function okApi(overrides: Record<string, unknown> = {}) {
  let messageId = 100;
  return (method: string): unknown => {
    if (method in overrides) return overrides[method];
    if (method === 'sendMessage') return { ok: true, result: { message_id: ++messageId } };
    return { ok: true, result: true };
  };
}

describe('Telegram native events — announcement messages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('create sends the formatted announcement, pins it, and returns a {chatId,messageId} ref', async () => {
    const calls = stubTelegramApi(okApi());
    const adapter = createTelegramAdapter(TOKEN);

    const ref = await nativeEvents(adapter).create('chat-1', EVENT);

    expect(parseTelegramEventRef(ref)).toEqual({ chatId: 'chat-1', messageId: 101 });

    const send = calls.find((c) => c.method === 'sendMessage');
    expect(send?.body.chat_id).toBe('chat-1');
    expect(send?.body.parse_mode).toBe('MarkdownV2');
    const text = String(send?.body.text);
    expect(text).toContain('📅 *Band Practice*');
    expect(text).toContain('🕒 Tue Jul 21 7:00pm – 9:00pm');
    expect(text).toContain('📍 The Garage');
    expect(text).toContain('Bring the new songs');

    const pin = calls.find((c) => c.method === 'pinChatMessage');
    expect(pin?.body).toMatchObject({ chat_id: 'chat-1', message_id: 101, disable_notification: true });
  });

  it('create still succeeds when pinning fails (no pin rights)', async () => {
    stubTelegramApi(okApi({
      pinChatMessage: { ok: false, error_code: 400, description: 'Bad Request: not enough rights to pin a message' },
    }));
    const adapter = createTelegramAdapter(TOKEN);

    const ref = await nativeEvents(adapter).create('chat-1', EVENT);
    expect(parseTelegramEventRef(ref).messageId).toBe(101);
  });

  it('update edits the SAME message in place and returns the same ref', async () => {
    const calls = stubTelegramApi(okApi());
    const adapter = createTelegramAdapter(TOKEN);

    const ref = await nativeEvents(adapter).create('chat-1', EVENT);
    const moved = { ...EVENT, startAtMs: new Date(2026, 6, 22, 20, 0, 0, 0).getTime(), endAtMs: undefined };
    const newRef = await nativeEvents(adapter).update('chat-1', ref, moved);

    expect(parseTelegramEventRef(newRef)).toEqual(parseTelegramEventRef(ref));
    const edit = calls.find((c) => c.method === 'editMessageText');
    expect(edit?.body.chat_id).toBe('chat-1');
    expect(edit?.body.message_id).toBe(101);
    expect(String(edit?.body.text)).toContain('Wed Jul 22 8:00pm');
    // No second sendMessage: updates never post replacement announcements.
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  });

  it('update treats an identical-content edit ("message is not modified") as success', async () => {
    stubTelegramApi(okApi({
      editMessageText: {
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified: specified new message content is the same',
      },
    }));
    const adapter = createTelegramAdapter(TOKEN);

    const ref = await nativeEvents(adapter).create('chat-1', EVENT);
    await expect(nativeEvents(adapter).update('chat-1', ref, EVENT)).resolves.toBe(ref);
  });

  it('cancel edits the message to a cancelled rendering and unpins; unpin failure is silent', async () => {
    const calls = stubTelegramApi(okApi({
      unpinChatMessage: { ok: false, error_code: 400, description: 'Bad Request: not enough rights' },
    }));
    const adapter = createTelegramAdapter(TOKEN);

    const ref = await nativeEvents(adapter).create('chat-1', EVENT);
    await nativeEvents(adapter).cancel('chat-1', ref, EVENT);

    const edit = calls.find((c) => c.method === 'editMessageText');
    expect(edit?.body.message_id).toBe(101);
    expect(String(edit?.body.text)).toContain('❌ *CANCELLED — Band Practice*');
    expect(calls.some((c) => c.method === 'unpinChatMessage')).toBe(true);
  });

  it('update falls back to plain text when the MarkdownV2 edit fails to parse', async () => {
    let editAttempt = 0;
    const calls = stubTelegramApi((method) => {
      if (method === 'sendMessage') return { ok: true, result: { message_id: 7 } };
      if (method === 'editMessageText') {
        editAttempt += 1;
        if (editAttempt === 1) {
          return { ok: false, error_code: 400, description: "Bad Request: can't parse entities" };
        }
      }
      return { ok: true, result: true };
    });
    const adapter = createTelegramAdapter(TOKEN);

    const ref = await nativeEvents(adapter).create('chat-1', EVENT);
    await nativeEvents(adapter).update('chat-1', ref, EVENT);

    const edits = calls.filter((c) => c.method === 'editMessageText');
    expect(edits).toHaveLength(2);
    expect(edits[1]?.body.parse_mode).toBeUndefined();
  });

  it('update reposts the announcement (and re-pins) when the original message was deleted', async () => {
    const calls = stubTelegramApi(okApi({
      editMessageText: { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' },
    }));
    const adapter = createTelegramAdapter(TOKEN);

    const ref = await nativeEvents(adapter).create('chat-1', EVENT);
    const newRef = await nativeEvents(adapter).update('chat-1', ref, EVENT);

    // The repost is a NEW message, returned as a new ref for persistence.
    expect(parseTelegramEventRef(newRef)).toEqual({ chatId: 'chat-1', messageId: 102 });
    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(2);
    expect(String(sends[1]?.body.text)).toContain('📅 *Band Practice*');
    const pins = calls.filter((c) => c.method === 'pinChatMessage');
    expect(pins.map((p) => p.body.message_id)).toEqual([101, 102]);
  });

  it('cancel succeeds without a repost when the original message was deleted', async () => {
    const calls = stubTelegramApi(okApi({
      editMessageText: { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' },
    }));
    const adapter = createTelegramAdapter(TOKEN);

    const ref = await nativeEvents(adapter).create('chat-1', EVENT);
    await expect(nativeEvents(adapter).cancel('chat-1', ref, EVENT)).resolves.toBeUndefined();

    // No cancellation notice for a message nobody can see, and no unpin.
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'unpinChatMessage')).toBe(false);
  });

  it('other edit errors still surface instead of triggering a repost', async () => {
    const calls = stubTelegramApi(okApi({
      editMessageText: { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
    }));
    const adapter = createTelegramAdapter(TOKEN);

    const ref = await nativeEvents(adapter).create('chat-1', EVENT);
    await expect(nativeEvents(adapter).update('chat-1', ref, EVENT))
      .rejects.toThrow('chat not found');
    await expect(nativeEvents(adapter).cancel('chat-1', ref, EVENT))
      .rejects.toThrow('chat not found');
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  });

  it('rejects an unrecognized ref without calling the API', async () => {
    const calls = stubTelegramApi(okApi());
    const adapter = createTelegramAdapter(TOKEN);

    await expect(nativeEvents(adapter).update('chat-1', 'not-json', EVENT))
      .rejects.toThrow('Unrecognized Telegram event reference');
    await expect(nativeEvents(adapter).cancel('chat-1', '{"heldJobId":3}', EVENT))
      .rejects.toThrow('Unrecognized Telegram event reference');
    expect(calls).toHaveLength(0);
  });
});
