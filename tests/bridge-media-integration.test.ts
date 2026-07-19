process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeMap, BridgeRoute } from '../src/bridge/bridge-map.js';
import { parseBridgeEnvelope, type BridgeEnvelope } from '../src/bridge/envelope.js';
import { startBridge } from '../src/bridge/lifecycle.js';
import { createBridgeOutbox, type BridgeOutboxOps } from '../src/bridge/outbox.js';
import { createRelayCapture, type RelayCapture } from '../src/bridge/relay-capture.js';
import type { BridgeBufferOps } from '../src/bridge/summary-buffer.js';
import type { BridgeTransport, InboundBridgeResult } from '../src/bridge/transport.js';
import type { InboundMessage } from '../src/core/inbound-message.js';
import { createMessageRef } from '../src/core/message-ref.js';
import type { PlatformMessenger } from '../src/core/platform-messenger.js';
import { config } from '../src/utils/config.js';
import type { BridgeOutboxEntry } from '../src/utils/db-types.js';

const { transcribeAudio } = vi.hoisted(() => ({
  transcribeAudio: vi.fn<(audio: Buffer, mimeType: string) => Promise<string | null>>(),
}));

vi.mock('../src/features/voice.js', () => ({ transcribeAudio }));

const ORIGINAL_CONFIG = {
  bridgeEnabled: config.BRIDGE_ENABLED,
  instanceId: config.INSTANCE_ID,
  mediaEnabled: config.BRIDGE_MEDIA_ENABLED,
  platform: config.MESSAGING_PLATFORM,
};
const ORIGINAL_ENV = {
  mediaEnabled: process.env.BRIDGE_MEDIA_ENABLED,
  mediaMaxBytes: process.env.BRIDGE_MEDIA_MAX_BYTES,
  whisperUrl: process.env.WHISPER_URL,
};

const ROUTE: BridgeRoute = {
  id: 'media-round-trip',
  endpoints: [
    { instance: 'instance-a', chatId: 'source-chat' },
    { instance: 'instance-b', chatId: 'target-chat' },
  ],
  direction: 'both',
  modeToWhatsApp: 'verbatim',
  modeToDiscord: 'verbatim',
  relayCommands: false,
  ingestRelayed: false,
  mediaRelay: true,
};

function bridgeMap(route: BridgeRoute = ROUTE): BridgeMap {
  return {
    instances: [
      { id: 'instance-a', platform: 'discord' },
      { id: 'instance-b', platform: 'discord' },
    ],
    routes: [route],
  };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'discord',
    chatId: 'source-chat',
    senderId: 'sender-1',
    senderName: 'Taylor',
    messageId: 'message-1',
    fromSelf: false,
    isStatusBroadcast: false,
    isGroupChat: true,
    timestampMs: 1_800_000_000_000,
    text: 'hello',
    hasVisualMedia: false,
    raw: createMessageRef({ platform: 'discord', chatId: 'source-chat', id: 'message-1', ref: {} }),
    ...overrides,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function createMemoryOutboxOps(): { ops: BridgeOutboxOps; rows: BridgeOutboxEntry[] } {
  const rows: BridgeOutboxEntry[] = [];
  const ops: BridgeOutboxOps = {
    enqueueBridgeOutbox: vi.fn(async (envelope: BridgeEnvelope) => {
      const row: BridgeOutboxEntry = {
        id: rows.length + 1,
        envelopeJson: JSON.stringify(envelope),
        targetInstance: envelope.targetInstance,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: Date.now(),
        lastError: null,
        createdAt: Date.now(),
      };
      rows.push(row);
      return row;
    }),
    claimDueBridgeOutbox: vi.fn(async (limit: number) => rows
      .filter((row) => row.status === 'pending' && row.nextAttemptAt <= Date.now())
      .slice(0, limit)),
    markBridgeOutboxSent: vi.fn(async (id: number) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return false;
      row.status = 'sent';
      return true;
    }),
    markBridgeOutboxDead: vi.fn(async (id: number, error: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return false;
      row.status = 'dead';
      row.lastError = error;
      return true;
    }),
    bumpBridgeOutboxAttempt: vi.fn(async (id: number, nextAt: number, error: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return false;
      row.attempts++;
      row.nextAttemptAt = nextAt;
      row.lastError = error;
      return true;
    }),
    deferBridgeOutbox: vi.fn(async (id: number, nextAt: number, error: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return false;
      row.nextAttemptAt = nextAt;
      row.lastError = error;
      return true;
    }),
    bridgeOutboxCounts: vi.fn(async () => ({
      pending: rows.filter((row) => row.status === 'pending').length,
      sent: rows.filter((row) => row.status === 'sent').length,
      dead: rows.filter((row) => row.status === 'dead').length,
      oldestPendingCreatedAt: rows.find((row) => row.status === 'pending')?.createdAt ?? null,
    })),
  };
  return { ops, rows };
}

function createBufferOps(): BridgeBufferOps {
  return {
    appendBridgeBuffer: vi.fn(async () => undefined),
    takeBridgeBuffer: vi.fn(async () => []),
    restoreBridgeBuffer: vi.fn(async () => undefined),
    bridgeBufferDepths: vi.fn(async () => ({})),
  };
}

function createMessenger(order: string[]): {
  messenger: PlatformMessenger;
  order: string[];
  sendText: ReturnType<typeof vi.fn<PlatformMessenger['sendText']>>;
  sendDocument: ReturnType<typeof vi.fn<PlatformMessenger['sendDocument']>>;
  sendAudio: ReturnType<typeof vi.fn<PlatformMessenger['sendAudio']>>;
} {
  const sendText = vi.fn<PlatformMessenger['sendText']>(async () => { order.push('text'); });
  const sendDocument = vi.fn<PlatformMessenger['sendDocument']>(async (chatId) => {
    order.push('document');
    return createMessageRef({ platform: 'discord', chatId, id: 'document-1', ref: {} });
  });
  const sendAudio = vi.fn<PlatformMessenger['sendAudio']>(async () => { order.push('audio'); });
  return {
    messenger: { sendText, sendDocument, sendAudio } as unknown as PlatformMessenger,
    order,
    sendText,
    sendDocument,
    sendAudio,
  };
}

function createLoopbackTransport(receiverMaxBytes?: string): {
  transport: BridgeTransport;
  wireEnvelopes: BridgeEnvelope[];
  receivedEnvelopes: BridgeEnvelope[];
} {
  let inboundHandler: ((envelope: BridgeEnvelope) => Promise<InboundBridgeResult>) | null = null;
  const wireEnvelopes: BridgeEnvelope[] = [];
  const receivedEnvelopes: BridgeEnvelope[] = [];
  return {
    wireEnvelopes,
    receivedEnvelopes,
    transport: {
      async deliver(envelope): Promise<void> {
        const wireValue = JSON.parse(JSON.stringify(envelope)) as unknown;
        wireEnvelopes.push(wireValue as BridgeEnvelope);
        const senderMaxBytes = process.env.BRIDGE_MEDIA_MAX_BYTES;
        if (receiverMaxBytes !== undefined) process.env.BRIDGE_MEDIA_MAX_BYTES = receiverMaxBytes;
        let parsed: BridgeEnvelope | null;
        try {
          parsed = parseBridgeEnvelope(wireValue);
        } finally {
          restoreEnv('BRIDGE_MEDIA_MAX_BYTES', senderMaxBytes);
        }
        if (!parsed) throw new Error('loopback receiver rejected bridge envelope');
        if (!inboundHandler) throw new Error('loopback receiver is not started');
        receivedEnvelopes.push(parsed);
        await inboundHandler(parsed);
      },
      async startInbound(handler): Promise<void> {
        inboundHandler = handler;
      },
      async stop(): Promise<void> {
        inboundHandler = null;
      },
    },
  };
}

interface RoundTripHarness {
  bufferOps: BridgeBufferOps;
  capture: RelayCapture;
  loopback: ReturnType<typeof createLoopbackTransport>;
  messenger: ReturnType<typeof createMessenger>;
  rows: BridgeOutboxEntry[];
  pump(): Promise<void>;
  stop(): Promise<void>;
}

const harnesses: RoundTripHarness[] = [];

async function createHarness(options: { route?: BridgeRoute; receiverMaxBytes?: string } = {}): Promise<RoundTripHarness> {
  const map = bridgeMap(options.route);
  const order: string[] = [];
  const messenger = createMessenger(order);
  const loopback = createLoopbackTransport(options.receiverMaxBytes);
  const receiverOutbox = createMemoryOutboxOps();
  const senderOutbox = createMemoryOutboxOps();
  const bufferOps = createBufferOps();
  const seen = new Set<string>();

  config.BRIDGE_ENABLED = true;
  config.INSTANCE_ID = 'instance-b';
  config.MESSAGING_PLATFORM = 'discord';
  config.BRIDGE_MEDIA_ENABLED = true;

  const receiver = await startBridge({
    getMessenger: () => messenger.messenger,
    loadBridgeMap: () => map,
    bridgeSeenInsert: async (key) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    bridgeSeenDelete: async (key) => seen.delete(key),
    outboxOps: receiverOutbox.ops,
    bufferOps,
    transport: loopback.transport,
  });
  if (!receiver) throw new Error('expected receiver bridge lifecycle');

  const outbox = createBridgeOutbox({
    transport: loopback.transport,
    resolveTargetUrl: () => null,
    ops: senderOutbox.ops,
  });
  outbox.start();
  const capture = createRelayCapture({
    instanceId: 'instance-a',
    bridgeMap: map,
    enqueue: (envelope) => outbox.enqueue(envelope),
  });

  const harness: RoundTripHarness = {
    bufferOps,
    capture,
    loopback,
    messenger,
    rows: senderOutbox.rows,
    async pump(): Promise<void> {
      await vi.advanceTimersByTimeAsync(0);
      for (let index = 0; index < 10 && senderOutbox.rows.length === 0; index++) await Promise.resolve();
      expect(senderOutbox.rows).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
    },
    async stop(): Promise<void> {
      await outbox.stop();
      await receiver.stop();
    },
  };
  harnesses.push(harness);
  return harness;
}

describe('bridge media integration round trips', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.BRIDGE_MEDIA_ENABLED = 'true';
    process.env.BRIDGE_MEDIA_MAX_BYTES = '65536';
    delete process.env.WHISPER_URL;
    transcribeAudio.mockReset();
  });

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    config.BRIDGE_ENABLED = ORIGINAL_CONFIG.bridgeEnabled;
    config.INSTANCE_ID = ORIGINAL_CONFIG.instanceId;
    config.BRIDGE_MEDIA_ENABLED = ORIGINAL_CONFIG.mediaEnabled;
    config.MESSAGING_PLATFORM = ORIGINAL_CONFIG.platform;
    restoreEnv('BRIDGE_MEDIA_ENABLED', ORIGINAL_ENV.mediaEnabled);
    restoreEnv('BRIDGE_MEDIA_MAX_BYTES', ORIGINAL_ENV.mediaMaxBytes);
    restoreEnv('WHISPER_URL', ORIGINAL_ENV.whisperUrl);
  });

  it('round-trips image bytes through capture, outbox, transport, and document delivery after unchanged v1 text', async () => {
    const bytes = Buffer.from('image-round-trip');
    const harness = await createHarness();

    harness.capture.capture(inbound({
      text: 'field notes',
      hasVisualMedia: true,
      media: { buffer: bytes, contentType: 'image/png', fileName: 'field.png', kind: 'image' },
    }));
    await harness.pump();

    expect(harness.loopback.wireEnvelopes[0]).toMatchObject({ v: 2, text: '[image] field notes' });
    expect(harness.messenger.sendText).toHaveBeenCalledWith(
      'target-chat',
      'Taylor (Discord): [image] field notes',
    );
    expect(harness.messenger.sendDocument).toHaveBeenCalledWith('target-chat', {
      bytes: new Uint8Array(bytes),
      mimetype: 'image/png',
      fileName: 'field.png',
    });
    expect(harness.messenger.order).toEqual(['text', 'document']);
    expect(harness.rows[0]?.status).toBe('sent');
  });

  it('round-trips a voice note as ptt audio with transcript text and one capture-side download', async () => {
    process.env.WHISPER_URL = 'http://whisper.test';
    const bytes = Buffer.from('voice-round-trip');
    const response = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => bytes,
    } as unknown as Response;
    const fetchMock = vi.fn<typeof fetch>(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    transcribeAudio.mockResolvedValue('rehearsal at seven');
    const harness = await createHarness();

    harness.capture.capture(inbound({
      text: null,
      audio: { url: 'https://media.example/voice.ogg', contentType: 'audio/ogg', ptt: true },
    }));
    await harness.pump();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transcribeAudio).toHaveBeenCalledWith(bytes, 'audio/ogg');
    expect(harness.messenger.sendText).toHaveBeenCalledWith(
      'target-chat',
      'Taylor (Discord): 🎤 rehearsal at seven',
    );
    expect(harness.messenger.sendAudio).toHaveBeenCalledWith('target-chat', {
      bytes: new Uint8Array(bytes),
      mimetype: 'audio/ogg',
      ptt: true,
    });
    expect(harness.messenger.order).toEqual(['text', 'audio']);
  });

  it('salvages text-only at the receiver when its media cap is smaller than the sender cap', async () => {
    process.env.BRIDGE_MEDIA_MAX_BYTES = '131072';
    const bytes = Buffer.alloc(65_560, 1);
    const harness = await createHarness({ receiverMaxBytes: '65536' });

    harness.capture.capture(inbound({
      text: 'large image',
      hasVisualMedia: true,
      media: { buffer: bytes, contentType: 'image/png', fileName: 'large.png', kind: 'image' },
    }));
    await harness.pump();

    expect(harness.loopback.wireEnvelopes[0]).toMatchObject({ v: 2, media: expect.any(Object) });
    expect(harness.loopback.receivedEnvelopes[0]).toMatchObject({ v: 2, text: '[image] large image' });
    expect(harness.loopback.receivedEnvelopes[0]).not.toHaveProperty('media');
    expect(harness.messenger.sendText).toHaveBeenCalledTimes(1);
    expect(harness.messenger.sendDocument).not.toHaveBeenCalled();
    expect(harness.messenger.sendAudio).not.toHaveBeenCalled();
    expect(harness.rows[0]?.status).toBe('sent');
  });

  it('keeps summary-mode text behavior at v1 while dropping media before the summary buffer', async () => {
    const summaryRoute = { ...ROUTE, modeToDiscord: 'summary' as const };
    const harness = await createHarness({ route: summaryRoute });

    harness.capture.capture(inbound({
      text: 'summary caption',
      hasVisualMedia: true,
      media: { buffer: Buffer.from('summary-image'), contentType: 'image/png', kind: 'image' },
    }));
    await harness.pump();

    expect(harness.loopback.wireEnvelopes[0]).toMatchObject({ v: 2, media: expect.any(Object) });
    expect(harness.bufferOps.appendBridgeBuffer).toHaveBeenCalledTimes(1);
    const bufferedJson = vi.mocked(harness.bufferOps.appendBridgeBuffer).mock.calls[0]?.[1];
    const buffered = JSON.parse(bufferedJson ?? '{}') as Record<string, unknown>;
    expect(buffered).toMatchObject({ text: '[image] summary caption', kind: 'media-placeholder' });
    expect(buffered).not.toHaveProperty('media');
    expect(harness.messenger.sendText).not.toHaveBeenCalled();
    expect(harness.messenger.sendDocument).not.toHaveBeenCalled();
    expect(harness.messenger.sendAudio).not.toHaveBeenCalled();
  });

  it('stays v1 end to end with media flags off and performs no download or media send', async () => {
    process.env.BRIDGE_MEDIA_ENABLED = 'false';
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const harness = await createHarness();

    harness.capture.capture(inbound({
      text: 'flags off',
      hasVisualMedia: true,
      media: { url: 'https://media.example/photo.png', contentType: 'image/png', kind: 'image' },
    }));
    await harness.pump();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.loopback.wireEnvelopes[0]).toMatchObject({ v: 1, text: '[image] flags off' });
    expect(harness.loopback.wireEnvelopes[0]).not.toHaveProperty('media');
    expect(harness.loopback.receivedEnvelopes[0]).toMatchObject({ v: 1 });
    expect(harness.messenger.sendText).toHaveBeenCalledWith(
      'target-chat',
      'Taylor (Discord): [image] flags off',
    );
    expect(harness.messenger.sendDocument).not.toHaveBeenCalled();
    expect(harness.messenger.sendAudio).not.toHaveBeenCalled();
  });
});
