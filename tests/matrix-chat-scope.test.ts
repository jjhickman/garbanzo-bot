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

// F3 (review debt): mirrors telegram-processor-gating.test.ts's synthesized-
// placeholder trio exactly, but exercised through the REAL
// core/process-inbound-message.js + core/process-group-message.js pipeline
// (unlike the describe block above, which stubs processInboundMessage out
// entirely to inspect wiring) — that's the only way to prove the core
// dispatch-skip gate (keyed on inbound.synthesizedPlaceholder) actually
// fires for Matrix, not just that processor.ts computed a placeholder
// string.
describe('Matrix processor — synthesized voice placeholder (mirrors telegram)', () => {
  function createMessenger() {
    const sendText = vi.fn(async () => undefined);
    return {
      platform: 'matrix' as const,
      sendText,
      sendPoll: vi.fn(async () => undefined),
      sendTextWithRef: vi.fn(async (chatId: string) => ({ platform: 'matrix' as const, chatId, id: 'm1', ref: {} })),
      sendDocument: vi.fn(async (chatId: string) => ({ platform: 'matrix' as const, chatId, id: 'd1', ref: {} })),
      sendAudio: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
    };
  }

  function setupRealPipelineMocks() {
    const getResponse = vi.fn(async (query: string) => `assistant:${query}`);

    vi.doMock('../src/platforms/matrix/matrix-config.js', () => ({
      isMatrixRoomEnabled: vi.fn(() => true),
      matrixRoomRequiresMention: vi.fn(() => false),
      isMatrixFeatureEnabled: vi.fn(() => true),
      getMatrixRoomName: vi.fn(() => undefined),
    }));
    vi.doMock('../src/core/response-router.js', () => ({ getResponse }));
    vi.doMock('../src/bridge/capture-hook.js', () => ({ captureForBridge: vi.fn() }));

    return { getResponse };
  }

  function setupVoiceMocks(transcribeAudio: ReturnType<typeof vi.fn>) {
    const mocks = setupRealPipelineMocks();
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));
    return mocks;
  }

  async function importProcessor() {
    const { processMatrixEvent } = await import('../src/platforms/matrix/processor.js');
    return { processMatrixEvent };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    // The describe block above stubs these two modules out entirely via
    // vi.doMock (to inspect wiring, never invoking the real pipeline) —
    // doMock registrations outlive vi.resetModules()/vi.restoreAllMocks()
    // and would otherwise leak into these tests, silently swallowing every
    // dispatch before it reaches getResponse. Unmock them so the REAL
    // core/process-inbound-message.js + core/process-group-message.js run,
    // which is the whole point of this describe block.
    vi.doUnmock('../src/core/process-inbound-message.js');
    vi.doUnmock('../src/core/process-group-message.js');
    vi.doUnmock('../src/utils/config.js');
    vi.doUnmock('../src/middleware/logger.js');
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('transcribes a captionless voice message and dispatches the transcript', async () => {
    const transcribeAudio = vi.fn(async () => 'hello from the transcript');
    const mocks = setupVoiceMocks(transcribeAudio);
    const { processMatrixEvent } = await importProcessor();
    const messenger = createMessenger();

    await processMatrixEvent(
      messenger as never,
      baseEvent({
        text: '',
        audio: { url: 'mxc://example/voice-1', contentType: 'audio/ogg', buffer: Buffer.from([1, 2, 3]) },
      }),
      { ownerId: '@owner:example.org', botUserId: '@garbanzo:example.org' },
    );

    expect(transcribeAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), 'audio/ogg');
    expect(mocks.getResponse).toHaveBeenCalledWith('hello from the transcript', expect.anything(), expect.any(Function), undefined);
  });

  it('synthesizes the [voice note] placeholder without an AI reply when transcription fails', async () => {
    const transcribeAudio = vi.fn(async () => null);
    const mocks = setupVoiceMocks(transcribeAudio);
    const { processMatrixEvent } = await importProcessor();
    const messenger = createMessenger();

    await processMatrixEvent(
      messenger as never,
      baseEvent({
        text: '',
        audio: { url: 'mxc://example/voice-2', contentType: 'audio/ogg', buffer: Buffer.from([9]) },
      }),
      { ownerId: '@owner:example.org', botUserId: '@garbanzo:example.org' },
    );

    // The message survives (transcription was attempted, nothing threw), but
    // a synthesized placeholder is not a prompt: no AI reply dispatch, and no
    // reply sent — this is the F3 regression: before the fix, processor.ts
    // never set inbound.synthesizedPlaceholder, so the core dispatch-skip
    // gate never fired and the bot replied to its own '[voice note]' text.
    expect(transcribeAudio).toHaveBeenCalled();
    expect(mocks.getResponse).not.toHaveBeenCalled();
    expect(messenger.sendText).not.toHaveBeenCalled();
  });

  it('synthesizes the placeholder without an AI reply when the buffer failed to download', async () => {
    const transcribeAudio = vi.fn(async () => 'should not be called');
    const mocks = setupVoiceMocks(transcribeAudio);
    const { processMatrixEvent } = await importProcessor();
    const messenger = createMessenger();

    await processMatrixEvent(
      messenger as never,
      baseEvent({
        text: '',
        audio: { url: 'mxc://example/voice-3', contentType: 'audio/ogg' }, // no buffer — download failed
      }),
      { ownerId: '@owner:example.org', botUserId: '@garbanzo:example.org' },
    );

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(mocks.getResponse).not.toHaveBeenCalled();
    expect(messenger.sendText).not.toHaveBeenCalled();
  });

  it('still replies when a user literally types "[voice note]" as text', async () => {
    const transcribeAudio = vi.fn(async () => 'unused');
    const mocks = setupVoiceMocks(transcribeAudio);
    const { processMatrixEvent } = await importProcessor();
    const messenger = createMessenger();

    await processMatrixEvent(
      messenger as never,
      baseEvent({ text: '[voice note]' }),
      { ownerId: '@owner:example.org', botUserId: '@garbanzo:example.org' },
    );

    // Flag-not-text-equality: user-typed placeholder text is a normal
    // message and gets a normal AI reply dispatch.
    expect(mocks.getResponse).toHaveBeenCalledWith('[voice note]', expect.anything(), expect.any(Function), undefined);
  });

  it('does not transcribe when the voice message already has caption text', async () => {
    const transcribeAudio = vi.fn(async () => 'should not be called either');
    const mocks = setupVoiceMocks(transcribeAudio);
    const { processMatrixEvent } = await importProcessor();
    const messenger = createMessenger();

    await processMatrixEvent(
      messenger as never,
      baseEvent({
        text: 'has a caption',
        audio: { url: 'mxc://example/voice-4', contentType: 'audio/ogg', buffer: Buffer.from([1]) },
      }),
      { ownerId: '@owner:example.org', botUserId: '@garbanzo:example.org' },
    );

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(mocks.getResponse).toHaveBeenCalledWith('has a caption', expect.anything(), expect.any(Function), undefined);
  });
});

describe('Matrix processor — owner alert routing', () => {
  function createMessenger() {
    const sendText = vi.fn(async () => undefined);
    return {
      platform: 'matrix' as const,
      sendText,
      sendPoll: vi.fn(async () => undefined),
      sendTextWithRef: vi.fn(async (chatId: string) => ({ platform: 'matrix' as const, chatId, id: 'm1', ref: {} })),
      sendDocument: vi.fn(async (chatId: string) => ({ platform: 'matrix' as const, chatId, id: 'd1', ref: {} })),
      sendAudio: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
    };
  }

  function setupRealPipelineMocks(options: {
    moderationFlag?: boolean;
    feedbackOwnerAlert?: string;
  } = {}) {
    vi.doMock('../src/platforms/matrix/matrix-config.js', () => ({
      isMatrixRoomEnabled: vi.fn(() => true),
      matrixRoomRequiresMention: vi.fn(() => false),
      isMatrixFeatureEnabled: vi.fn(() => true),
      getMatrixRoomName: vi.fn(() => 'Matrix Room'),
    }));
    vi.doMock('../src/core/response-router.js', () => ({ getResponse: vi.fn(async () => null) }));
    vi.doMock('../src/bridge/capture-hook.js', () => ({ captureForBridge: vi.fn() }));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio: vi.fn(async () => null) }));
    vi.doMock('../src/middleware/context.js', () => ({ recordMessage: vi.fn(async () => undefined) }));
    vi.doMock('../src/middleware/stats.js', () => ({
      recordGroupMessage: vi.fn(),
      recordModerationFlag: vi.fn(),
      recordBotResponse: vi.fn(),
    }));
    vi.doMock('../src/utils/db.js', () => ({
      touchProfile: vi.fn(async () => undefined),
      updateActiveGroups: vi.fn(async () => undefined),
      logModeration: vi.fn(async () => undefined),
      getStrikeCount: vi.fn(async () => 0),
    }));
    vi.doMock('../src/middleware/rate-limit.js', () => ({
      checkRateLimit: vi.fn(() => null),
      recordResponse: vi.fn(),
    }));
    vi.doMock('../src/middleware/retry.js', () => ({ queueRetry: vi.fn() }));
    vi.doMock('../src/features/memory-extract.js', () => ({ maybeExtractCommunityFacts: vi.fn(async () => undefined) }));
    vi.doMock('../src/features/moderation.js', () => ({
      checkMessage: vi.fn(async () => (options.moderationFlag
        ? { reason: 'hate', severity: 'high', source: 'regex' }
        : null)),
      formatModerationAlert: vi.fn(() => 'moderation alert'),
      applyStrikeAndMute: vi.fn(() => ({ muted: false })),
      isSoftMuted: vi.fn(() => false),
    }));
    vi.doMock('../src/features/feedback.js', () => ({
      handleFeedbackSubmit: vi.fn(async () => ({
        response: 'feedback received',
        ownerAlert: options.feedbackOwnerAlert,
      })),
      handleUpvote: vi.fn(async () => 'upvoted'),
    }));
  }

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock('../src/core/process-inbound-message.js');
    vi.doUnmock('../src/core/process-group-message.js');
    vi.doUnmock('../src/utils/config.js');
    vi.doUnmock('../src/middleware/logger.js');
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('sends Matrix moderation owner alerts to the resolved owner DM room id', async () => {
    setupRealPipelineMocks({ moderationFlag: true });
    const { processMatrixEvent } = await import('../src/platforms/matrix/processor.js');
    const messenger = createMessenger();

    await processMatrixEvent(
      messenger as never,
      baseEvent({ text: 'flag this message' }),
      {
        ownerId: '@owner:example.org',
        ownerRoomId: '!owner-dm:example.org',
        botUserId: '@garbanzo:example.org',
      },
    );

    expect(messenger.sendText).toHaveBeenCalledWith('!owner-dm:example.org', 'moderation alert');
    expect(messenger.sendText).not.toHaveBeenCalledWith('@owner:example.org', 'moderation alert');
  });

  it('sends Matrix feedback owner alerts to the room id while owner identity remains the MXID', async () => {
    setupRealPipelineMocks({ feedbackOwnerAlert: 'feedback alert' });
    vi.doMock('../src/core/process-group-message.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/core/process-group-message.js')>();
      return {
        ...actual,
        processGroupMessage: vi.fn(actual.processGroupMessage),
      };
    });
    const { processMatrixEvent } = await import('../src/platforms/matrix/processor.js');
    const groupModule = await import('../src/core/process-group-message.js');
    const messenger = createMessenger();

    await processMatrixEvent(
      messenger as never,
      baseEvent({ text: '!suggest make this better', senderId: '@owner:example.org' }),
      {
        ownerId: '@owner:example.org',
        ownerRoomId: '!owner-dm:example.org',
        botUserId: '@garbanzo:example.org',
      },
    );

    expect(messenger.sendText).toHaveBeenCalledWith('!configured:example.org', 'feedback received', expect.anything());
    expect(messenger.sendText).toHaveBeenCalledWith('!owner-dm:example.org', 'feedback alert');
    const calls = vi.mocked(groupModule.processGroupMessage).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({
      ownerId: '!owner-dm:example.org',
      ownerUserId: '@owner:example.org',
    });
  });
});
