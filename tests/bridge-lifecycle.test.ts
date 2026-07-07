process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeMap } from '../src/bridge/bridge-map.js';
import type { BridgeEnvelope } from '../src/bridge/envelope.js';
import { getCaptureForBridge, startBridge, type StartBridgeDeps } from '../src/bridge/lifecycle.js';
import type { BridgeOutboxOps } from '../src/bridge/outbox.js';
import type { BridgeBufferOps } from '../src/bridge/summary-buffer.js';
import type { BridgeTransport } from '../src/bridge/transport.js';
import type { PlatformMessenger } from '../src/core/platform-messenger.js';
import { WhatsAppOutboundHeldError } from '../src/platforms/whatsapp/outbound-safety.js';
import { config } from '../src/utils/config.js';
import type { BridgeOutboxEntry } from '../src/utils/db-types.js';

const { recordMessage } = vi.hoisted(() => ({
  recordMessage: vi.fn(async () => undefined),
}));

vi.mock('../src/middleware/context.js', () => ({
  recordMessage,
}));

const VERBATIM_ROUTE: BridgeMap['routes'][number] = {
  id: 'verbatim-route',
  endpoints: [
    { instance: 'discord-band', chatId: 'chan-1' },
    { instance: 'whatsapp-band', chatId: 'group-1@g.us' },
  ],
  direction: 'both',
  modeToWhatsApp: 'verbatim',
  modeToDiscord: 'verbatim',
  relayCommands: false,
  ingestRelayed: false,
};

const MAP: BridgeMap = {
  instances: [
    { id: 'discord-band', platform: 'discord' },
    { id: 'whatsapp-band', platform: 'whatsapp' },
  ],
  routes: [VERBATIM_ROUTE],
};

function makeEnvelope(overrides: Partial<BridgeEnvelope> = {}): BridgeEnvelope {
  return {
    v: 1,
    routeId: 'verbatim-route',
    origin: {
      instance: 'whatsapp-band',
      platform: 'whatsapp',
      chatId: 'group-1@g.us',
      messageId: 'wa-msg-1',
      senderId: 'sender-1',
      senderName: 'Ana',
    },
    targetInstance: 'discord-band',
    targetChatId: 'chan-1',
    text: 'hello from whatsapp',
    kind: 'message',
    sentAtMs: 1_800_000_000_000,
    idempotencyKey: 'whatsapp-band:group-1@g.us:wa-msg-1',
    ...overrides,
  };
}

function fakeMessenger(sendText: PlatformMessenger['sendText']): PlatformMessenger {
  return { sendText } as unknown as PlatformMessenger;
}

function fakeTransport(): BridgeTransport {
  return {
    async deliver(): Promise<void> {},
    async startInbound(): Promise<void> {},
    async stop(): Promise<void> {},
  };
}

function fakeOutboxOps(): BridgeOutboxOps {
  return {
    enqueueBridgeOutbox: vi.fn(async (envelope: BridgeEnvelope): Promise<BridgeOutboxEntry> => ({
      id: 1,
      envelopeJson: JSON.stringify(envelope),
      targetInstance: envelope.targetInstance,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: null,
      createdAt: Date.now(),
    })),
    claimDueBridgeOutbox: vi.fn(async () => []),
    markBridgeOutboxSent: vi.fn(async () => true),
    markBridgeOutboxDead: vi.fn(async () => true),
    bumpBridgeOutboxAttempt: vi.fn(async () => true),
    bridgeOutboxCounts: vi.fn(async () => ({ pending: 0, sent: 0, dead: 0 })),
  };
}

function fakeBufferOps(): BridgeBufferOps {
  return {
    appendBridgeBuffer: vi.fn(async () => undefined),
    takeBridgeBuffer: vi.fn(async () => []),
    restoreBridgeBuffer: vi.fn(async () => undefined),
    bridgeBufferDepths: vi.fn(async () => ({})),
  };
}

function expectStarted<T>(bridge: T | null): T {
  if (!bridge) throw new Error('expected startBridge to return a lifecycle');
  return bridge;
}

function fakeBridgeSeen(): {
  insert: NonNullable<StartBridgeDeps['bridgeSeenInsert']>;
  del: NonNullable<StartBridgeDeps['bridgeSeenDelete']>;
} {
  const seen = new Set<string>();
  return {
    insert: vi.fn(async (key: string) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    del: vi.fn(async (key: string) => seen.delete(key)),
  };
}

// These tests reason about mode selection ("this instance's platform"), so
// they pin config.MESSAGING_PLATFORM to 'discord' directly rather than
// relying on the process env (the mandated verify invocation runs the suite
// with MESSAGING_PLATFORM=whatsapp, which would otherwise flip which side of
// modeToWhatsApp/modeToDiscord is exercised).
const ORIGINAL_PLATFORM = config.MESSAGING_PLATFORM;

beforeEach(() => {
  config.MESSAGING_PLATFORM = 'discord';
});

afterEach(() => {
  config.MESSAGING_PLATFORM = ORIGINAL_PLATFORM;
  recordMessage.mockClear();
});

describe('startBridge — flags-off inertness', () => {
  afterEach(() => {
    config.BRIDGE_ENABLED = false;
  });

  it('returns null and calls none of the injected deps when BRIDGE_ENABLED is false', async () => {
    config.BRIDGE_ENABLED = false;
    const getMessenger = vi.fn();
    const loadBridgeMap = vi.fn();
    const bridgeSeenInsert = vi.fn();
    const bridgeSeenDelete = vi.fn();

    const result = await startBridge({ getMessenger, loadBridgeMap, bridgeSeenInsert, bridgeSeenDelete });

    expect(result).toBeNull();
    expect(getMessenger).not.toHaveBeenCalled();
    expect(loadBridgeMap).not.toHaveBeenCalled();
    expect(bridgeSeenInsert).not.toHaveBeenCalled();
    expect(bridgeSeenDelete).not.toHaveBeenCalled();
  });
});

describe('startBridge — bridge map load failure', () => {
  afterEach(() => {
    config.BRIDGE_ENABLED = false;
  });

  it('returns null when the bridge map fails to load', async () => {
    config.BRIDGE_ENABLED = true;

    const result = await startBridge({
      getMessenger: () => null,
      loadBridgeMap: () => null,
    });

    expect(result).toBeNull();
  });
});

describe('startBridge — required dedup-ordering fix (T6 review)', () => {
  afterEach(async () => {
    config.BRIDGE_ENABLED = false;
    vi.restoreAllMocks();
  });

  it('deletes the dedup key when delivery throws, so a re-post of the same envelope is accepted (not duplicate)', async () => {
    config.BRIDGE_ENABLED = true;

    const sendText = vi.fn()
      .mockRejectedValueOnce(new Error('discord send failed'))
      .mockResolvedValueOnce(undefined);
    const seen = fakeBridgeSeen();

    const bridge = expectStarted(await startBridge({
      getMessenger: () => fakeMessenger(sendText),
      loadBridgeMap: () => MAP,
      bridgeSeenInsert: seen.insert,
      bridgeSeenDelete: seen.del,
      outboxOps: fakeOutboxOps(),
      bufferOps: fakeBufferOps(),
      transport: fakeTransport(),
    }));

    const envelope = makeEnvelope();

    await expect(bridge.handler(envelope)).rejects.toThrow('discord send failed');
    expect(seen.del).toHaveBeenCalledWith(envelope.idempotencyKey);

    const secondResult = await bridge.handler(envelope);
    expect(secondResult).toBe('accepted');
    expect(sendText).toHaveBeenCalledTimes(2);

    await bridge.stop();
  });

  it('keeps the dedup key when delivery is buffered (WhatsApp held = success) — a re-post is a duplicate', async () => {
    config.BRIDGE_ENABLED = true;

    const sendText = vi.fn(async () => {
      throw new WhatsAppOutboundHeldError(3, 'daily limit');
    });
    const seen = fakeBridgeSeen();
    const bufferOps = fakeBufferOps();

    const bridge = expectStarted(await startBridge({
      getMessenger: () => fakeMessenger(sendText),
      loadBridgeMap: () => MAP,
      bridgeSeenInsert: seen.insert,
      bridgeSeenDelete: seen.del,
      outboxOps: fakeOutboxOps(),
      bufferOps,
      transport: fakeTransport(),
    }));

    const envelope = makeEnvelope();

    const firstResult = await bridge.handler(envelope);
    expect(firstResult).toBe('accepted');
    expect(seen.del).not.toHaveBeenCalled();
    expect(bufferOps.appendBridgeBuffer).toHaveBeenCalledTimes(1);

    const secondResult = await bridge.handler(envelope);
    expect(secondResult).toBe('duplicate');
    expect(sendText).toHaveBeenCalledTimes(1);

    await bridge.stop();
  });

  it('routes to the summary buffer (never a direct send) when the route mode for this platform is summary', async () => {
    config.BRIDGE_ENABLED = true;
    const summaryMap: BridgeMap = {
      ...MAP,
      routes: [{ ...VERBATIM_ROUTE, modeToDiscord: 'summary' }],
    };
    const sendText = vi.fn(async () => undefined);
    const seen = fakeBridgeSeen();
    const bufferOps = fakeBufferOps();

    const bridge = expectStarted(await startBridge({
      getMessenger: () => fakeMessenger(sendText),
      loadBridgeMap: () => summaryMap,
      bridgeSeenInsert: seen.insert,
      bridgeSeenDelete: seen.del,
      outboxOps: fakeOutboxOps(),
      bufferOps,
      transport: fakeTransport(),
    }));

    const result = await bridge.handler(makeEnvelope());

    expect(result).toBe('accepted');
    expect(bufferOps.appendBridgeBuffer).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();

    await bridge.stop();
  });

  it('records relayed text into receiving context after verbatim delivery when the route opts in', async () => {
    config.BRIDGE_ENABLED = true;
    const ingestMap: BridgeMap = {
      ...MAP,
      routes: [{ ...VERBATIM_ROUTE, ingestRelayed: true }],
    };
    const sendText = vi.fn(async () => undefined);

    const bridge = expectStarted(await startBridge({
      getMessenger: () => fakeMessenger(sendText),
      loadBridgeMap: () => ingestMap,
      bridgeSeenInsert: fakeBridgeSeen().insert,
      bridgeSeenDelete: fakeBridgeSeen().del,
      outboxOps: fakeOutboxOps(),
      bufferOps: fakeBufferOps(),
      transport: fakeTransport(),
    }));

    await expect(bridge.handler(makeEnvelope())).resolves.toBe('accepted');

    expect(recordMessage).toHaveBeenCalledWith(
      'chan-1',
      'sender-1',
      'Ana (WhatsApp): hello from whatsapp',
    );

    await bridge.stop();
  });

  it('does not record relayed text when the route ingest flag is off', async () => {
    config.BRIDGE_ENABLED = true;
    const bridge = expectStarted(await startBridge({
      getMessenger: () => fakeMessenger(vi.fn(async () => undefined)),
      loadBridgeMap: () => MAP,
      bridgeSeenInsert: fakeBridgeSeen().insert,
      bridgeSeenDelete: fakeBridgeSeen().del,
      outboxOps: fakeOutboxOps(),
      bufferOps: fakeBufferOps(),
      transport: fakeTransport(),
    }));

    await expect(bridge.handler(makeEnvelope())).resolves.toBe('accepted');

    expect(recordMessage).not.toHaveBeenCalled();

    await bridge.stop();
  });

  it('does not record relayed text when summary mode buffers the envelope', async () => {
    config.BRIDGE_ENABLED = true;
    const summaryMap: BridgeMap = {
      ...MAP,
      routes: [{ ...VERBATIM_ROUTE, modeToDiscord: 'summary', ingestRelayed: true }],
    };
    const bridge = expectStarted(await startBridge({
      getMessenger: () => fakeMessenger(vi.fn(async () => undefined)),
      loadBridgeMap: () => summaryMap,
      bridgeSeenInsert: fakeBridgeSeen().insert,
      bridgeSeenDelete: fakeBridgeSeen().del,
      outboxOps: fakeOutboxOps(),
      bufferOps: fakeBufferOps(),
      transport: fakeTransport(),
    }));

    await expect(bridge.handler(makeEnvelope())).resolves.toBe('accepted');

    expect(recordMessage).not.toHaveBeenCalled();

    await bridge.stop();
  });

  it('does not record relayed text when verbatim delivery is buffered by WhatsApp safety', async () => {
    config.BRIDGE_ENABLED = true;
    const ingestMap: BridgeMap = {
      ...MAP,
      routes: [{ ...VERBATIM_ROUTE, ingestRelayed: true }],
    };
    const sendText = vi.fn(async () => {
      throw new WhatsAppOutboundHeldError(3, 'daily limit');
    });
    const bridge = expectStarted(await startBridge({
      getMessenger: () => fakeMessenger(sendText),
      loadBridgeMap: () => ingestMap,
      bridgeSeenInsert: fakeBridgeSeen().insert,
      bridgeSeenDelete: fakeBridgeSeen().del,
      outboxOps: fakeOutboxOps(),
      bufferOps: fakeBufferOps(),
      transport: fakeTransport(),
    }));

    await expect(bridge.handler(makeEnvelope())).resolves.toBe('accepted');

    expect(recordMessage).not.toHaveBeenCalled();

    await bridge.stop();
  });

  it('registers the capture hook singleton while running and clears it on stop', async () => {
    config.BRIDGE_ENABLED = true;

    const bridge = expectStarted(await startBridge({
      getMessenger: () => fakeMessenger(vi.fn(async () => undefined)),
      loadBridgeMap: () => MAP,
      bridgeSeenInsert: fakeBridgeSeen().insert,
      bridgeSeenDelete: fakeBridgeSeen().del,
      outboxOps: fakeOutboxOps(),
      bufferOps: fakeBufferOps(),
      transport: fakeTransport(),
    }));

    expect(getCaptureForBridge()).toBeTypeOf('function');

    await bridge.stop();

    expect(getCaptureForBridge()).toBeNull();
  });
});
