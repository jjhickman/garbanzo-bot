process.env.MESSAGING_PLATFORM ??= 'matrix';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.MATRIX_HOMESERVER_URL ??= 'https://matrix.example.org';
process.env.MATRIX_ACCESS_TOKEN ??= 'test_matrix_token';
process.env.MATRIX_OWNER_ID ??= '@owner:example.org';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockProcessorDeps(chatScope: 'all' | 'configured') {
  const processInboundMessage = vi.fn(async () => undefined);
  const isMatrixRoomEnabled = vi.fn((roomId: string) => roomId === '!configured:example.org');

  vi.doMock('../src/core/process-inbound-message.js', () => ({ processInboundMessage }));
  vi.doMock('../src/core/process-group-message.js', () => ({ processGroupMessage: vi.fn(async () => undefined) }));
  vi.doMock('../src/utils/config.js', () => ({
    config: {
      MESSAGING_PLATFORM: 'matrix',
      MATRIX_CHAT_SCOPE: chatScope,
    },
  }));
  vi.doMock('../src/middleware/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('../src/features/voice.js', () => ({ transcribeAudio: vi.fn(async () => null) }));
  vi.doMock('../src/platforms/matrix/matrix-config.js', () => ({
    isMatrixRoomEnabled,
    matrixRoomRequiresMention: vi.fn(() => false),
    isMatrixFeatureEnabled: vi.fn(() => true),
    getMatrixRoomName: vi.fn(() => undefined),
  }));
  vi.doMock('../src/core/response-router.js', () => ({ getResponse: vi.fn(async () => 'ok') }));
  vi.doMock('../src/bridge/capture-hook.js', () => ({ captureForBridge: vi.fn() }));

  return { processInboundMessage, isMatrixRoomEnabled };
}

function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: '$msg',
    roomId: '!configured:example.org',
    isGroupChat: true,
    text: 'hello',
    senderId: '@ada:example.org',
    timestampMs: Date.now(),
    ...overrides,
  };
}

describe('Matrix processor chat-scope hook wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('passes isMatrixRoomEnabled as the ingestion hook when MATRIX_CHAT_SCOPE=configured', async () => {
    const { processInboundMessage, isMatrixRoomEnabled } = mockProcessorDeps('configured');
    const { processMatrixEvent } = await import('../src/platforms/matrix/processor.js');

    await processMatrixEvent(
      { sendText: vi.fn(async () => undefined) } as never,
      baseEvent(),
      { ownerId: '@owner:example.org', botUserId: '@garbanzo:example.org' },
    );

    const env = processInboundMessage.mock.calls[0]?.[3] as { shouldIngestGroupChat?: (roomId: string) => boolean } | undefined;
    expect(env?.shouldIngestGroupChat).toBe(isMatrixRoomEnabled);
  });

  it('does not pass an ingestion hook when MATRIX_CHAT_SCOPE=all', async () => {
    const { processInboundMessage } = mockProcessorDeps('all');
    const { processMatrixEvent } = await import('../src/platforms/matrix/processor.js');

    await processMatrixEvent(
      { sendText: vi.fn(async () => undefined) } as never,
      baseEvent(),
      { ownerId: '@owner:example.org', botUserId: '@garbanzo:example.org' },
    );

    const env = processInboundMessage.mock.calls[0]?.[3] as { shouldIngestGroupChat?: (roomId: string) => boolean } | undefined;
    expect(env?.shouldIngestGroupChat).toBeUndefined();
  });

  it('defaults MATRIX_CHAT_SCOPE to configured in the real env schema', async () => {
    vi.resetModules();
    const { matrixSchema } = await import('../src/utils/config/matrix.js');
    const parsed = matrixSchema.parse({});
    expect(parsed.MATRIX_CHAT_SCOPE).toBe('configured');
  });
});
