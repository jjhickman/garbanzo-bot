process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it, vi } from 'vitest';

import type { InboundMessage } from '../src/core/inbound-message.js';

const loggerDebug = vi.hoisted(() => vi.fn());

vi.mock('../src/middleware/logger.js', () => ({
  logger: { debug: loggerDebug, warn: vi.fn() },
}));

function inbound(url: string): InboundMessage {
  return {
    platform: 'discord',
    chatId: 'chat-1',
    senderId: 'sender-1',
    isGroupChat: true,
    text: 'photo',
    media: {
      url,
      contentType: 'image/png',
      fileName: 'photo.png',
      kind: 'image',
    },
  };
}

describe('bridge media capture concurrency', () => {
  it('falls back immediately for a fifth capture and releases slots on completion', async () => {
    const pending = new Map<string, (response: Response) => void>();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => new Promise<Response>((resolve) => {
      pending.set(String(url), resolve);
    })));
    const { captureInboundMedia } = await import('../src/bridge/media-capture.js');

    const captures = Array.from({ length: 4 }, (_, index) =>
      captureInboundMedia(inbound(`https://cdn.example/${index}.png`), 65_536, `route-${index}`));
    const saturated = await captureInboundMedia(
      inbound('https://cdn.example/fifth.png'),
      65_536,
      'route-fifth',
    );

    expect(saturated).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(loggerDebug).toHaveBeenCalledWith(
      { routeId: 'route-fifth' },
      'Bridge capture: media preparation skipped because all capture slots are busy',
    );

    pending.get('https://cdn.example/0.png')?.(new Response(Buffer.from('done')));
    await captures[0];
    const sixthPromise = captureInboundMedia(
      inbound('https://cdn.example/sixth.png'),
      65_536,
      'route-sixth',
    );
    expect(fetch).toHaveBeenCalledTimes(5);

    for (const [url, resolve] of pending) {
      if (url !== 'https://cdn.example/0.png') resolve(new Response(Buffer.from('done')));
    }
    await Promise.all([...captures.slice(1), sixthPromise]);
  });

  it('releases a capture slot when base64 preparation throws', async () => {
    const { captureInboundMedia } = await import('../src/bridge/media-capture.js');
    const throwingBuffer = {
      byteLength: 1,
      toString(): string {
        throw new Error('encode failed');
      },
    } as unknown as Buffer;

    for (let index = 0; index < 4; index++) {
      const errorInbound = inbound('https://unused.example/error.png');
      if (!errorInbound.media) throw new Error('expected media fixture');
      await expect(captureInboundMedia({
        ...errorInbound,
        media: {
          ...errorInbound.media,
          buffer: throwingBuffer,
        },
      }, 65_536, `route-error-${index}`)).rejects.toThrow('encode failed');
    }

    const successfulInbound = inbound('https://unused.example/ok.png');
    if (!successfulInbound.media) throw new Error('expected media fixture');
    await expect(captureInboundMedia({
      ...successfulInbound,
      media: {
        ...successfulInbound.media,
        buffer: Buffer.from('ok'),
      },
    }, 65_536, 'route-after-error')).resolves.toMatchObject({ kind: 'image' });
  });
});
