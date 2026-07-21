import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMatrixAdapter, type MatrixSendClient } from '../src/platforms/matrix/adapter.js';
import { parseMatrixEventRef } from '../src/platforms/matrix/native-events.js';
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

const ROOM = '!room:example.org';

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

function createClient(overrides: Partial<MatrixSendClient> = {}): MatrixSendClient & {
  sendMessage: ReturnType<typeof vi.fn>;
} {
  let counter = 0;
  return {
    sendMessage: vi.fn(async () => `$evt-${++counter}`),
    ...overrides,
  } as MatrixSendClient & { sendMessage: ReturnType<typeof vi.fn> };
}

describe('Matrix native events — announcement messages', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('create sends the formatted announcement (body + formatted_body) and returns a {roomId,eventId} ref', async () => {
    const client = createClient();
    const adapter = createMatrixAdapter(client);

    const ref = await nativeEvents(adapter).create(ROOM, EVENT);

    expect(parseMatrixEventRef(ref)).toEqual({ roomId: ROOM, eventId: '$evt-1' });
    const [roomId, content] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(roomId).toBe(ROOM);
    expect(content.msgtype).toBe('m.text');
    expect(content.format).toBe('org.matrix.custom.html');
    const body = String(content.body);
    expect(body).toContain('📅 Band Practice');
    expect(body).toContain('🕒 Tue Jul 21 7:00pm – 9:00pm');
    expect(body).toContain('📍 The Garage');
    expect(body).toContain('Bring the new songs');
    expect(String(content.formatted_body)).toContain('<strong>Band Practice</strong>');
  });

  it('update sends a proper m.replace edit targeting the original event and keeps the ref', async () => {
    const client = createClient();
    const adapter = createMatrixAdapter(client);

    const ref = await nativeEvents(adapter).create(ROOM, EVENT);
    const moved = { ...EVENT, startAtMs: new Date(2026, 6, 22, 20, 0, 0, 0).getTime(), endAtMs: undefined };
    const newRef = await nativeEvents(adapter).update(ROOM, ref, moved);

    expect(newRef).toBe(ref);
    const [, content] = client.sendMessage.mock.calls[1] as [string, Record<string, unknown>];
    expect(content['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$evt-1' });
    // Spec fallback rendering for non-edit-aware clients: '* '-prefixed copy.
    expect(String(content.body).startsWith('* ')).toBe(true);
    const newContent = content['m.new_content'] as Record<string, unknown>;
    expect(newContent.msgtype).toBe('m.text');
    expect(String(newContent.body)).toContain('Wed Jul 22 8:00pm');
    expect(String(newContent.formatted_body)).toContain('<strong>Band Practice</strong>');
  });

  it('a second update still targets the ORIGINAL announcement event id', async () => {
    const client = createClient();
    const adapter = createMatrixAdapter(client);

    const ref = await nativeEvents(adapter).create(ROOM, EVENT);
    const afterFirst = await nativeEvents(adapter).update(ROOM, ref, { ...EVENT, name: 'Practice v2' });
    await nativeEvents(adapter).update(ROOM, afterFirst, { ...EVENT, name: 'Practice v3' });

    const [, content] = client.sendMessage.mock.calls[2] as [string, Record<string, unknown>];
    expect(content['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$evt-1' });
  });

  it('cancel edits the announcement to a cancelled rendering', async () => {
    const client = createClient();
    const adapter = createMatrixAdapter(client);

    const ref = await nativeEvents(adapter).create(ROOM, EVENT);
    await nativeEvents(adapter).cancel(ROOM, ref, EVENT);

    const [, content] = client.sendMessage.mock.calls[1] as [string, Record<string, unknown>];
    expect(content['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$evt-1' });
    const newContent = content['m.new_content'] as Record<string, unknown>;
    expect(String(newContent.body)).toContain('❌ CANCELLED — Band Practice');
    expect(String(newContent.formatted_body)).toContain('<strong>CANCELLED — Band Practice</strong>');
  });

  it('retries a short M_LIMIT_EXCEEDED wait inline when creating', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const client = createClient({
      sendMessage: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          throw { statusCode: 429, body: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1_000 } };
        }
        return '$after-retry';
      }),
    });
    const adapter = createMatrixAdapter(client);

    const pending = nativeEvents(adapter).create(ROOM, EVENT);
    await vi.advanceTimersByTimeAsync(1_000);
    const ref = await pending;

    expect(parseMatrixEventRef(ref).eventId).toBe('$after-retry');
    expect(attempt).toBe(2);
  });

  it('rejects an unrecognized ref without calling the API', async () => {
    const client = createClient();
    const adapter = createMatrixAdapter(client);

    await expect(nativeEvents(adapter).update(ROOM, 'not-json', EVENT))
      .rejects.toThrow('Unrecognized Matrix event reference');
    await expect(nativeEvents(adapter).cancel(ROOM, '{"eventId":42}', EVENT))
      .rejects.toThrow('Unrecognized Matrix event reference');
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
