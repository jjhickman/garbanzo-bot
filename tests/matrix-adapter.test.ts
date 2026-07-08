import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMessageRef } from '../src/core/message-ref.js';
import { createMatrixAdapter, MatrixRateLimitError, type MatrixSendClient } from '../src/platforms/matrix/adapter.js';

function createClient(overrides: Partial<MatrixSendClient> = {}): MatrixSendClient {
  return {
    sendMessage: vi.fn(async () => '$sent'),
    uploadContent: vi.fn(async () => 'mxc://example/media'),
    redactEvent: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('Matrix adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends Matrix HTML content with plain body', async () => {
    const client = createClient();
    const adapter = createMatrixAdapter(client);

    await adapter.sendText('!room:example.org', 'Hello *world*');

    expect(client.sendMessage).toHaveBeenCalledWith('!room:example.org', expect.objectContaining({
      msgtype: 'm.text',
      body: 'Hello world',
      format: 'org.matrix.custom.html',
      formatted_body: 'Hello <strong>world</strong>',
    }));
  });

  it('includes Matrix reply metadata for a matrix MessageRef', async () => {
    const client = createClient();
    const adapter = createMatrixAdapter(client);
    const replyTo = createMessageRef({ platform: 'matrix', chatId: '!room:example.org', id: '$old', ref: {} });

    await adapter.sendText('!room:example.org', 'reply text', { replyTo });

    expect(client.sendMessage).toHaveBeenCalledWith('!room:example.org', expect.objectContaining({
      'm.relates_to': { 'm.in_reply_to': { event_id: '$old' } },
    }));
  });

  it('retries a short M_LIMIT_EXCEEDED wait inline, once', async () => {
    vi.useFakeTimers();
    const calls: Record<string, unknown>[] = [];
    let attempt = 0;
    const client = createClient({
      sendMessage: vi.fn(async (_roomId, content) => {
        calls.push(content);
        attempt += 1;
        if (attempt === 1) {
          throw { statusCode: 429, body: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1_500 } };
        }
        return '$after';
      }),
    });
    const adapter = createMatrixAdapter(client);

    const sendPromise = adapter.sendText('!room:example.org', 'short wait');
    await vi.advanceTimersByTimeAsync(1_499);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await sendPromise;

    expect(calls).toHaveLength(2);
    vi.useRealTimers();
  });

  it('honors a 45s Matrix M_LIMIT_EXCEEDED retry once for a direct send (restored ≤60s inline wait)', async () => {
    // Direct sends (group replies, owner DMs, welcome messages, moderation
    // alerts) have no outbox/transport deadline riding on them, so a normal
    // homeserver retry_after should be slept through and delivered — this
    // regressed when the adapter briefly throw-fast'd at a flat 2s budget
    // for every call, dropping any direct send a homeserver rate-limited
    // for longer than that (F2, review debt). Bridge deliveries keep the
    // short throw-fast budget — see 'still throws fast for a bridge
    // delivery' below.
    vi.useFakeTimers();
    const calls: Record<string, unknown>[] = [];
    let attempt = 0;
    const client = createClient({
      sendMessage: vi.fn(async (_roomId, content) => {
        calls.push(content);
        attempt += 1;
        if (attempt === 1) {
          throw { statusCode: 429, body: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 45_000 } };
        }
        return '$after';
      }),
    });
    const adapter = createMatrixAdapter(client);

    const sendPromise = adapter.sendText('!room:example.org', 'medium wait');
    await vi.advanceTimersByTimeAsync(44_999);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await sendPromise;

    expect(calls).toHaveLength(2);
    vi.useRealTimers();
  });

  it('caps the thrown retryAfterMs at 60s and throws immediately for absurd server values, even for a direct send', async () => {
    const client = createClient({
      sendMessage: vi.fn(async () => {
        throw { statusCode: 429, body: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 90_000 } };
      }),
    });
    const adapter = createMatrixAdapter(client);

    const result = await adapter.sendText('!room:example.org', 'too long').catch((err: unknown) => err);

    expect(result).toBeInstanceOf(MatrixRateLimitError);
    expect((result as MatrixRateLimitError).retryAfterMs).toBe(60_000);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reads a Retry-After header (seconds) when retry_after_ms is absent and waits it out inline for a direct send', async () => {
    // Below the restored 60s direct-send budget, so this now sleeps and
    // delivers rather than throwing — the header value must still be
    // parsed correctly and drive the wait duration.
    vi.useFakeTimers();
    let attempt = 0;
    const client = createClient({
      sendMessage: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          throw { statusCode: 429, headers: { 'retry-after': '30' } };
        }
        return '$after-header';
      }),
    });
    const adapter = createMatrixAdapter(client);

    const sendPromise = adapter.sendText('!room:example.org', 'header only');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await sendPromise;

    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('still throws fast for a bridge delivery even at 45s, unlike the restored direct-send inline wait', async () => {
    // sendTextForBridge (used by the bridge's relay-deliver.ts, not plain
    // sendText) keeps the original narrow throw-fast budget: a bridge
    // delivery runs through the outbox's serial drain and the HTTP
    // transport's 10s timeout, so it must never sleep through a long
    // retry_after inside the call.
    const client = createClient({
      sendMessage: vi.fn(async () => {
        throw { statusCode: 429, body: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 45_000 } };
      }),
    });
    const adapter = createMatrixAdapter(client);

    const result = await adapter.sendTextForBridge?.('!room:example.org', 'bridge relay')
      .catch((err: unknown) => err);

    expect(result).toBeInstanceOf(MatrixRateLimitError);
    expect((result as MatrixRateLimitError).retryAfterMs).toBe(45_000);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sendMatrixTextForBridge throws fast on the same 2s budget when called directly with a raw client', async () => {
    const { sendMatrixTextForBridge } = await import('../src/platforms/matrix/adapter.js');
    const client = createClient({
      sendMessage: vi.fn(async () => {
        throw { statusCode: 429, body: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 3_000 } };
      }),
    });

    const result = await sendMatrixTextForBridge(client, '!room:example.org', 'bridge relay')
      .catch((err: unknown) => err);

    expect(result).toBeInstanceOf(MatrixRateLimitError);
    expect((result as MatrixRateLimitError).retryAfterMs).toBe(3_000);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('uploads and sends documents and audio through mxc URIs', async () => {
    const client = createClient();
    const adapter = createMatrixAdapter(client);

    await adapter.sendDocument('!room:example.org', {
      bytes: new Uint8Array([1, 2]),
      mimetype: 'application/pdf',
      fileName: 'sheet.pdf',
    });
    await adapter.sendAudio('!room:example.org', {
      bytes: new Uint8Array([3]),
      mimetype: 'audio/ogg',
      ptt: true,
    });

    expect(client.uploadContent).toHaveBeenCalledTimes(2);
    expect(client.sendMessage).toHaveBeenCalledWith('!room:example.org', expect.objectContaining({
      msgtype: 'm.file',
      url: 'mxc://example/media',
    }));
    expect(client.sendMessage).toHaveBeenCalledWith('!room:example.org', expect.objectContaining({
      msgtype: 'm.audio',
      url: 'mxc://example/media',
    }));
  });
});
