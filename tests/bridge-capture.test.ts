process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeMap } from '../src/bridge/bridge-map.js';
import type { BridgeEnvelope } from '../src/bridge/envelope.js';
import { createRelayCapture } from '../src/bridge/relay-capture.js';
import { createMessageRef } from '../src/core/message-ref.js';
import type { InboundMessage } from '../src/core/inbound-message.js';

vi.mock('../src/middleware/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const MAP: BridgeMap = {
  instances: [
    { id: 'discord-band', platform: 'discord' },
    { id: 'whatsapp-band', platform: 'whatsapp' },
  ],
  routes: [
    {
      id: 'band-both',
      endpoints: [
        { instance: 'discord-band', chatId: 'chan-1' },
        { instance: 'whatsapp-band', chatId: 'group-1@g.us' },
      ],
      direction: 'both',
      modeToWhatsApp: 'summary',
      modeToDiscord: 'verbatim',
      relayCommands: false,
    },
    {
      id: 'oneway-d2w',
      endpoints: [
        { instance: 'discord-band', chatId: 'chan-2' },
        { instance: 'whatsapp-band', chatId: 'group-2@g.us' },
      ],
      direction: 'one-way',
      from: 'discord-band',
      modeToWhatsApp: 'summary',
      modeToDiscord: 'verbatim',
      relayCommands: false,
    },
    {
      id: 'relay-cmds',
      endpoints: [
        { instance: 'discord-band', chatId: 'chan-3' },
        { instance: 'whatsapp-band', chatId: 'group-3@g.us' },
      ],
      direction: 'both',
      modeToWhatsApp: 'summary',
      modeToDiscord: 'verbatim',
      relayCommands: true,
    },
  ],
};

const GROUP_MAP: BridgeMap = {
  instances: [
    { id: 'discord-band', platform: 'discord' },
    { id: 'whatsapp-band', platform: 'whatsapp' },
    { id: 'telegram-band', platform: 'telegram' },
    { id: 'matrix-band', platform: 'matrix' },
  ],
  routes: [
    {
      id: 'all-band-groups',
      endpoints: [
        { instance: 'discord-band', chatId: 'chan-1' },
        { instance: 'whatsapp-band', chatId: 'group-1@g.us' },
        { instance: 'telegram-band', chatId: 'tg-chat-1' },
        { instance: 'matrix-band', chatId: '!room:example.org' },
      ],
      direction: 'both',
      modeToWhatsApp: 'summary',
      modeToDiscord: 'verbatim',
      relayCommands: false,
    },
  ],
};

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'discord',
    chatId: 'chan-1',
    senderId: 'sender-1',
    senderName: 'Ana',
    messageId: 'msg-1',
    fromSelf: false,
    isStatusBroadcast: false,
    isGroupChat: true,
    timestampMs: 1_800_000_000_000,
    text: 'hello world',
    hasVisualMedia: false,
    raw: createMessageRef({ platform: 'discord', chatId: 'chan-1', id: 'msg-1', ref: {} }),
    ...overrides,
  };
}

async function tickMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function capture(instanceId: string, map: BridgeMap = MAP) {
  const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(async () => undefined);
  return { relay: createRelayCapture({ instanceId, bridgeMap: map, enqueue }), enqueue };
}

describe('createRelayCapture', () => {
  afterEach(() => {
    delete process.env.WHISPER_URL;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('enqueues a text message envelope addressed to the route\'s other endpoint', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound());

    expect(enqueue).toHaveBeenCalledTimes(1);
    const envelope = enqueue.mock.calls[0]?.[0];
    expect(envelope).toMatchObject({
      v: 1,
      routeId: 'band-both',
      targetInstance: 'whatsapp-band',
      targetChatId: 'group-1@g.us',
      text: 'hello world',
      kind: 'message',
      idempotencyKey: '["discord-band","chan-1","msg-1","whatsapp-band","group-1@g.us"]',
      origin: {
        instance: 'discord-band',
        platform: 'discord',
        chatId: 'chan-1',
        messageId: 'msg-1',
        senderId: 'sender-1',
        senderName: 'Ana',
      },
    });
  });

  it('fans out an N-ary group message to every other endpoint with distinct target-scoped keys', () => {
    const { relay, enqueue } = capture('discord-band', GROUP_MAP);

    relay.capture(inbound());

    expect(enqueue).toHaveBeenCalledTimes(3);
    const envelopes = enqueue.mock.calls.map(([envelope]) => envelope);
    expect(envelopes.map((envelope) => ({
      targetInstance: envelope.targetInstance,
      targetChatId: envelope.targetChatId,
    }))).toEqual([
      { targetInstance: 'whatsapp-band', targetChatId: 'group-1@g.us' },
      { targetInstance: 'telegram-band', targetChatId: 'tg-chat-1' },
      { targetInstance: 'matrix-band', targetChatId: '!room:example.org' },
    ]);

    const keys = envelopes.map((envelope) => envelope.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual([
      '["discord-band","chan-1","msg-1","whatsapp-band","group-1@g.us"]',
      '["discord-band","chan-1","msg-1","telegram-band","tg-chat-1"]',
      '["discord-band","chan-1","msg-1","matrix-band","!room:example.org"]',
    ]);
  });

  it('keeps 2-endpoint routes to one fan-out envelope for back-compat', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound());

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      targetInstance: 'whatsapp-band',
      targetChatId: 'group-1@g.us',
    });
  });

  it('carries the configured chat display name on the envelope origin', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ chatName: 'practice' }));

    expect(enqueue.mock.calls[0]?.[0].origin.chatName).toBe('practice');
  });

  it('stores a trimmed chat display name when the source provides surrounding whitespace', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ chatName: '  practice  ' }));

    expect(enqueue.mock.calls[0]?.[0].origin.chatName).toBe('practice');
  });

  it('is a no-op when no route matches the chat id', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ chatId: 'unmapped-chat' }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('allows either endpoint to send on a both-direction route', () => {
    const discordSide = capture('discord-band');
    discordSide.relay.capture(inbound({ chatId: 'chan-1' }));
    expect(discordSide.enqueue).toHaveBeenCalledTimes(1);

    const whatsappSide = capture('whatsapp-band');
    whatsappSide.relay.capture(inbound({
      platform: 'whatsapp',
      chatId: 'group-1@g.us',
      messageId: 'wa-msg-1',
    }));
    expect(whatsappSide.enqueue).toHaveBeenCalledTimes(1);
  });

  it('only relays in the declared direction on a one-way route', () => {
    const fromSide = capture('discord-band');
    fromSide.relay.capture(inbound({ chatId: 'chan-2' }));
    expect(fromSide.enqueue).toHaveBeenCalledTimes(1);

    const toSide = capture('whatsapp-band');
    toSide.relay.capture(inbound({
      platform: 'whatsapp',
      chatId: 'group-2@g.us',
      messageId: 'wa-msg-2',
    }));
    expect(toSide.enqueue).not.toHaveBeenCalled();
  });

  it('skips bang-commands when the route does not allow relayCommands', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ text: '!song list' }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('relays bang-commands when the route allows relayCommands', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ chatId: 'chan-3', text: '!song list' }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ routeId: 'relay-cmds', text: '!song list' });
  });

  it('builds a voice-note placeholder for audio-only messages', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ text: null, audio: { url: 'https://cdn.example/a.ogg', contentType: 'audio/ogg' } }));

    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ kind: 'media-placeholder', text: '[voice note]' });
  });

  it('transcribes a Discord audio-only message when WHISPER_URL is configured', async () => {
    vi.resetModules();
    process.env.WHISPER_URL = 'http://whisper.test';
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3])));
    const transcribeAudio = vi.fn(async () => 'bring the charts');
    vi.stubGlobal('fetch', fetchMock);
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));
    const { createRelayCapture: createRelayCaptureWithVoice } = await import('../src/bridge/relay-capture.js');
    const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(async () => undefined);
    const relay = createRelayCaptureWithVoice({ instanceId: 'discord-band', bridgeMap: MAP, enqueue });

    relay.capture(inbound({ text: null, audio: { url: 'https://cdn.example/a.ogg', contentType: 'audio/ogg' } }));
    await tickMicrotasks();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.example/a.ogg',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(transcribeAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), 'audio/ogg');
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'message',
      text: '🎤 bring the charts',
    }));
  });

  it('falls back to the voice-note placeholder when audio transcription returns null', async () => {
    vi.resetModules();
    process.env.WHISPER_URL = 'http://whisper.test';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(new Uint8Array([4, 5, 6]))));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio: vi.fn(async () => null) }));
    const { createRelayCapture: createRelayCaptureWithVoice } = await import('../src/bridge/relay-capture.js');
    const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(async () => undefined);
    const relay = createRelayCaptureWithVoice({ instanceId: 'discord-band', bridgeMap: MAP, enqueue });

    relay.capture(inbound({ text: null, audio: { url: 'https://cdn.example/a.ogg', contentType: 'audio/ogg' } }));
    await tickMicrotasks();

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'media-placeholder',
      text: '[voice note]',
    }));
  });

  it('falls back to the voice-note placeholder when audio fetch fails', async () => {
    vi.resetModules();
    process.env.WHISPER_URL = 'http://whisper.test';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      throw new Error('cdn unavailable');
    }));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio: vi.fn(async () => 'unused') }));
    const { createRelayCapture: createRelayCaptureWithVoice } = await import('../src/bridge/relay-capture.js');
    const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(async () => undefined);
    const relay = createRelayCaptureWithVoice({ instanceId: 'discord-band', bridgeMap: MAP, enqueue });

    relay.capture(inbound({ text: null, audio: { url: 'https://cdn.example/a.ogg', contentType: 'audio/ogg' } }));
    await tickMicrotasks();

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'media-placeholder',
      text: '[voice note]',
    }));
  });

  it('logs a warning with the status (not the full CDN url) when the audio fetch response is not ok', async () => {
    vi.resetModules();
    process.env.WHISPER_URL = 'http://whisper.test';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio: vi.fn(async () => 'unused') }));
    const { createRelayCapture: createRelayCaptureWithVoice } = await import('../src/bridge/relay-capture.js');
    const { logger } = await import('../src/middleware/logger.js');
    const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(async () => undefined);
    const relay = createRelayCaptureWithVoice({ instanceId: 'discord-band', bridgeMap: MAP, enqueue });

    relay.capture(inbound({
      text: null,
      audio: { url: 'https://cdn.example/a.ogg?ex=deadbeef&sig=topsecret', contentType: 'audio/ogg' },
    }));
    await tickMicrotasks();

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'media-placeholder',
      text: '[voice note]',
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404, host: 'cdn.example' }),
      expect.any(String),
    );
    const loggedText = JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls);
    expect(loggedText).not.toContain('topsecret');
  });

  it('logs a warning with the error (not the full CDN url) when the audio fetch throws', async () => {
    vi.resetModules();
    process.env.WHISPER_URL = 'http://whisper.test';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      throw new Error('cdn unavailable');
    }));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio: vi.fn(async () => 'unused') }));
    const { createRelayCapture: createRelayCaptureWithVoice } = await import('../src/bridge/relay-capture.js');
    const { logger } = await import('../src/middleware/logger.js');
    const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(async () => undefined);
    const relay = createRelayCaptureWithVoice({ instanceId: 'discord-band', bridgeMap: MAP, enqueue });

    relay.capture(inbound({
      text: null,
      audio: { url: 'https://cdn.example/a.ogg?sig=topsecret', contentType: 'audio/ogg' },
    }));
    await tickMicrotasks();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'cdn.example', err: expect.any(Error) }),
      expect.any(String),
    );
    const loggedText = JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls);
    expect(loggedText).not.toContain('topsecret');
  });

  it('falls back to the voice-note placeholder when the CDN reports a Content-Length over the 20MB size cap', async () => {
    vi.resetModules();
    process.env.WHISPER_URL = 'http://whisper.test';
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1]), {
      headers: { 'content-length': String(21 * 1024 * 1024) },
    }));
    const transcribeAudio = vi.fn(async () => 'unused');
    vi.stubGlobal('fetch', fetchMock);
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));
    const { createRelayCapture: createRelayCaptureWithVoice } = await import('../src/bridge/relay-capture.js');
    const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(async () => undefined);
    const relay = createRelayCaptureWithVoice({ instanceId: 'discord-band', bridgeMap: MAP, enqueue });

    relay.capture(inbound({ text: null, audio: { url: 'https://cdn.example/big.ogg', contentType: 'audio/ogg' } }));
    await tickMicrotasks();

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'media-placeholder',
      text: '[voice note]',
    }));
  });

  it('aborts and falls back to the voice-note placeholder when the downloaded body exceeds the 20MB cap with no Content-Length header', async () => {
    vi.resetModules();
    process.env.WHISPER_URL = 'http://whisper.test';
    const oversized = new Uint8Array(21 * 1024 * 1024);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(oversized));
    const transcribeAudio = vi.fn(async () => 'unused');
    vi.stubGlobal('fetch', fetchMock);
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));
    const { createRelayCapture: createRelayCaptureWithVoice } = await import('../src/bridge/relay-capture.js');
    const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(async () => undefined);
    const relay = createRelayCaptureWithVoice({ instanceId: 'discord-band', bridgeMap: MAP, enqueue });

    relay.capture(inbound({ text: null, audio: { url: 'https://cdn.example/big.ogg', contentType: 'audio/ogg' } }));
    await tickMicrotasks();

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'media-placeholder',
      text: '[voice note]',
    }));
  });

  it('does not block the sync capture path while audio transcription is pending', async () => {
    vi.resetModules();
    process.env.WHISPER_URL = 'http://whisper.test';
    let releaseFetch: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(
      () => new Promise<Response>((resolve) => {
        releaseFetch = () => resolve(new Response(new Uint8Array([7, 8, 9])));
      }),
    ));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio: vi.fn(async () => 'later') }));
    const { createRelayCapture: createRelayCaptureWithVoice } = await import('../src/bridge/relay-capture.js');
    const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(async () => undefined);
    const relay = createRelayCaptureWithVoice({ instanceId: 'discord-band', bridgeMap: MAP, enqueue });

    const result = relay.capture(inbound({ text: null, audio: { url: 'https://cdn.example/a.ogg', contentType: 'audio/ogg' } }));

    expect(result).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
    releaseFetch?.();
    await tickMicrotasks();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ text: '🎤 later' }));
  });

  it('builds an image placeholder for visual-media-only messages', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ text: null, hasVisualMedia: true }));

    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ kind: 'media-placeholder', text: '[image]' });
  });

  it('appends caption text to a media placeholder', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ text: 'check this out', hasVisualMedia: true }));

    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ kind: 'media-placeholder', text: '[image] check this out' });
  });

  it('is a no-op for messages with no text, audio, or visual media', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ text: null }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips capture when the inbound message has no messageId', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ messageId: undefined }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never throws even when the enqueue promise rejects', async () => {
    const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(async () => {
      throw new Error('outbox unavailable');
    });
    const relay = createRelayCapture({ instanceId: 'discord-band', bridgeMap: MAP, enqueue });

    expect(() => relay.capture(inbound())).not.toThrow();

    // Let the rejected microtask settle before the test ends.
    await tickMicrotasks();
  });

  it('capture() returns synchronously without awaiting the enqueue promise', () => {
    let resolveEnqueue: (() => void) | undefined;
    const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(
      () => new Promise((resolve) => { resolveEnqueue = () => resolve(undefined); }),
    );
    const relay = createRelayCapture({ instanceId: 'discord-band', bridgeMap: MAP, enqueue });

    const result = relay.capture(inbound());

    expect(result).toBeUndefined();
    resolveEnqueue?.();
  });
});
