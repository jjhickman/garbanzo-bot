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

  it('honors a 45s Matrix M_LIMIT_EXCEEDED retry once', async () => {
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

  it('throws immediately when Matrix retry_after exceeds the 60s cap', async () => {
    vi.useFakeTimers();
    const client = createClient({
      sendMessage: vi.fn(async () => {
        throw { statusCode: 429, body: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 90_000 } };
      }),
    });
    const adapter = createMatrixAdapter(client);

    const result = await adapter.sendText('!room:example.org', 'too long').catch((err: unknown) => err);

    expect(result).toBeInstanceOf(MatrixRateLimitError);
    expect((result as MatrixRateLimitError).retryAfterMs).toBe(90_000);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
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
