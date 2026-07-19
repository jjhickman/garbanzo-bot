process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordMessage = vi.fn(async () => undefined);
const recordGroupMessage = vi.fn();
const checkMessage = vi.fn(async () => null);
const touchProfile = vi.fn(async () => undefined);
const updateActiveGroups = vi.fn(async () => undefined);
const handleIntroduction = vi.fn(async () => null);
const handleEventPassive = vi.fn(async () => null);

function mockCoreDeps() {
  recordMessage.mockClear();
  recordGroupMessage.mockClear();
  checkMessage.mockClear();
  touchProfile.mockClear();
  updateActiveGroups.mockClear();
  handleIntroduction.mockClear();
  handleEventPassive.mockClear();

  vi.doMock('../src/middleware/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('../src/features/moderation.js', () => ({
    checkMessage,
    formatModerationAlert: vi.fn(() => 'ALERT'),
    applyStrikeAndMute: vi.fn(() => ({ muted: false, dmMessage: null })),
  }));
  vi.doMock('../src/middleware/sanitize.js', () => ({
    sanitizeMessage: vi.fn((text: string) => ({ text, rejected: false })),
  }));
  vi.doMock('../src/utils/db.js', () => ({
    touchProfile,
    updateActiveGroups,
    logModeration: vi.fn(async () => undefined),
    getStrikeCount: vi.fn(async () => 0),
  }));
  vi.doMock('../src/middleware/context.js', () => ({ recordMessage }));
  vi.doMock('../src/middleware/stats.js', () => ({
    recordGroupMessage,
    recordModerationFlag: vi.fn(),
  }));
}

function makeInbound(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'whatsapp',
    chatId: 'group@g.us',
    senderId: 'user@s.whatsapp.net',
    messageId: 'message-1',
    fromSelf: false,
    isStatusBroadcast: false,
    isGroupChat: true,
    timestampMs: Date.now(),
    text: 'hello',
    hasVisualMedia: false,
    raw: { platform: 'whatsapp', chatId: 'group@g.us', id: 'message-1' },
    ...overrides,
  };
}

function makeHooks() {
  return {
    isReplyToBot: vi.fn(() => false),
    isAcknowledgment: vi.fn(() => false),
    sendAcknowledgmentReaction: vi.fn(async () => undefined),
    handleGroupMessage: vi.fn(async () => undefined),
    handleOwnerDM: vi.fn(async () => undefined),
    captureForBridge: vi.fn(),
  };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: 'owner@s.whatsapp.net',
    isGroupEnabled: vi.fn(() => true),
    introductionsChatId: null,
    eventsChatId: null,
    handleIntroduction,
    handleEventPassive,
    ...overrides,
  };
}

describe('core inbound WhatsApp chat-scope ingestion gate', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockCoreDeps();
  });

  it('drops an unconfigured group before recording, moderation, bridge capture, or dispatch', async () => {
    const { processInboundMessage } = await import('../src/core/process-inbound-message.js');
    const hooks = makeHooks();
    const shouldIngestGroupChat = vi.fn(() => false);

    await processInboundMessage(
      { sendText: vi.fn(async () => undefined) } as never,
      makeInbound() as never,
      hooks as never,
      makeEnv({ shouldIngestGroupChat }) as never,
    );

    expect(shouldIngestGroupChat).toHaveBeenCalledWith('group@g.us');
    expect(recordMessage).not.toHaveBeenCalled();
    expect(recordGroupMessage).not.toHaveBeenCalled();
    expect(touchProfile).not.toHaveBeenCalled();
    expect(updateActiveGroups).not.toHaveBeenCalled();
    expect(checkMessage).not.toHaveBeenCalled();
    expect(hooks.captureForBridge).not.toHaveBeenCalled();
    expect(hooks.handleGroupMessage).not.toHaveBeenCalled();
  });

  it('lets a configured group flow through normal recording and dispatch', async () => {
    const { processInboundMessage } = await import('../src/core/process-inbound-message.js');
    const hooks = makeHooks();

    await processInboundMessage(
      { sendText: vi.fn(async () => undefined) } as never,
      makeInbound() as never,
      hooks as never,
      makeEnv({ shouldIngestGroupChat: vi.fn(() => true) }) as never,
    );

    expect(recordMessage).toHaveBeenCalledWith('group@g.us', 'user@s.whatsapp.net', 'hello');
    expect(recordGroupMessage).toHaveBeenCalledWith('group@g.us', 'user@s.whatsapp.net');
    expect(checkMessage).toHaveBeenCalledWith('hello');
    expect(hooks.captureForBridge).toHaveBeenCalledTimes(1);
    expect(hooks.handleGroupMessage).toHaveBeenCalledTimes(1);
  });

  it('never gates DMs, even when the group-ingestion hook returns false', async () => {
    const { processInboundMessage } = await import('../src/core/process-inbound-message.js');
    const hooks = makeHooks();
    const shouldIngestGroupChat = vi.fn(() => false);

    await processInboundMessage(
      { sendText: vi.fn(async () => undefined) } as never,
      makeInbound({ chatId: 'owner@s.whatsapp.net', isGroupChat: false }) as never,
      hooks as never,
      makeEnv({ shouldIngestGroupChat }) as never,
    );

    expect(shouldIngestGroupChat).not.toHaveBeenCalled();
    expect(recordMessage).toHaveBeenCalledWith('owner@s.whatsapp.net', 'user@s.whatsapp.net', 'hello');
    expect(checkMessage).not.toHaveBeenCalled();
    expect(hooks.handleOwnerDM).toHaveBeenCalledTimes(1);
  });

  it('keeps current behavior when no ingestion hook is provided', async () => {
    const { processInboundMessage } = await import('../src/core/process-inbound-message.js');
    const hooks = makeHooks();

    await processInboundMessage(
      { sendText: vi.fn(async () => undefined) } as never,
      makeInbound() as never,
      hooks as never,
      makeEnv() as never,
    );

    expect(recordMessage).toHaveBeenCalledWith('group@g.us', 'user@s.whatsapp.net', 'hello');
    expect(recordGroupMessage).toHaveBeenCalledWith('group@g.us', 'user@s.whatsapp.net');
    expect(checkMessage).toHaveBeenCalledWith('hello');
    expect(hooks.handleGroupMessage).toHaveBeenCalledTimes(1);
  });
});

describe('WhatsApp processor chat-scope hook wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function mockProcessorDeps(
    chatScope: 'all' | 'configured',
    voice: {
      isVoice?: boolean;
      audioBuffer?: Buffer | null;
      transcript?: string | null;
    } = {},
  ) {
    const processInboundMessage = vi.fn(async () => undefined);
    const isGroupEnabled = vi.fn((chatId: string) => chatId === 'configured@g.us');

    vi.doMock('../src/core/process-inbound-message.js', () => ({ processInboundMessage }));
    vi.doMock('../src/utils/config.js', () => ({
      config: {
        OWNER_JID: 'owner@s.whatsapp.net',
        MESSAGING_PLATFORM: 'whatsapp',
        WHATSAPP_CHAT_SCOPE: chatScope,
      },
    }));
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../src/middleware/health.js', () => ({ markMessageReceived: vi.fn() }));
    vi.doMock('../src/platforms/whatsapp/media.js', () => ({
      isVoiceMessage: vi.fn(() => voice.isVoice ?? false),
      downloadVoiceAudio: vi.fn(async () => voice.audioBuffer ?? null),
    }));
    vi.doMock('../src/features/voice.js', () => ({
      transcribeAudio: vi.fn(async () => voice.transcript ?? null),
    }));
    vi.doMock('../src/features/introductions.js', () => ({ handleIntroduction: vi.fn(async () => null) }));
    vi.doMock('../src/features/events.js', () => ({ handleEventPassive: vi.fn(async () => null) }));
    vi.doMock('../src/core/groups-config.js', () => ({
      isGroupEnabled,
      getEnabledGroupJidByName: vi.fn(() => null),
    }));
    vi.doMock('../src/platforms/whatsapp/owner-commands.js', () => ({ handleOwnerDM: vi.fn(async () => undefined) }));
    vi.doMock('../src/platforms/whatsapp/group-handler.js', () => ({ handleGroupMessage: vi.fn(async () => undefined) }));
    vi.doMock('../src/platforms/whatsapp/reactions.js', () => ({
      isReplyToBot: vi.fn(() => false),
      isAcknowledgment: vi.fn(() => false),
    }));
    vi.doMock('../src/platforms/whatsapp/inbound.js', () => ({
      normalizeWhatsAppInboundMessage: vi.fn(() => makeInbound({ chatId: 'configured@g.us' })),
    }));
    vi.doMock('../src/platforms/whatsapp/adapter.js', () => ({
      createWhatsAppAdapter: vi.fn(() => ({ sendText: vi.fn(async () => undefined) })),
    }));
    vi.doMock('../src/platforms/whatsapp/outbound-safety.js', () => ({
      getWhatsAppOutboundSafety: vi.fn(() => undefined),
    }));
    vi.doMock('../src/bridge/capture-hook.js', () => ({ captureForBridge: vi.fn() }));

    return { processInboundMessage, isGroupEnabled };
  }

  it('passes isGroupEnabled as the ingestion hook when WHATSAPP_CHAT_SCOPE=configured', async () => {
    const { processInboundMessage, isGroupEnabled } = mockProcessorDeps('configured');
    const { processWhatsAppRawMessage } = await import('../src/platforms/whatsapp/processor.js');

    await processWhatsAppRawMessage({ user: { id: 'bot@s.whatsapp.net' } } as never, {} as never);

    const env = processInboundMessage.mock.calls[0]?.[3] as { shouldIngestGroupChat?: (chatId: string) => boolean } | undefined;
    expect(env?.shouldIngestGroupChat).toBe(isGroupEnabled);
  });

  it('does not pass an ingestion hook when WHATSAPP_CHAT_SCOPE=all', async () => {
    const { processInboundMessage } = mockProcessorDeps('all');
    const { processWhatsAppRawMessage } = await import('../src/platforms/whatsapp/processor.js');

    await processWhatsAppRawMessage({ user: { id: 'bot@s.whatsapp.net' } } as never, {} as never);

    const env = processInboundMessage.mock.calls[0]?.[3] as { shouldIngestGroupChat?: (chatId: string) => boolean } | undefined;
    expect(env?.shouldIngestGroupChat).toBeUndefined();
  });

  // WS3: voice messages must never be silently dropped. The processor used
  // to `return` on download/transcription failure, so nothing downstream —
  // moderation, recording, bridge capture — ever saw the message.
  function inboundArg(processInboundMessage: ReturnType<typeof vi.fn>) {
    return processInboundMessage.mock.calls[0]?.[1] as
      | { text: string; synthesizedPlaceholder?: boolean; audio?: { buffer?: Buffer; ptt?: boolean } }
      | undefined;
  }

  it('continues with a flagged placeholder when the voice download fails', async () => {
    const { processInboundMessage } = mockProcessorDeps('all', { isVoice: true, audioBuffer: null });
    const { processWhatsAppRawMessage } = await import('../src/platforms/whatsapp/processor.js');

    await processWhatsAppRawMessage({ user: { id: 'bot@s.whatsapp.net' } } as never, {} as never);

    expect(processInboundMessage).toHaveBeenCalledTimes(1);
    expect(inboundArg(processInboundMessage)).toMatchObject({
      text: '[voice note]',
      synthesizedPlaceholder: true,
    });
  });

  it('continues with a flagged placeholder when transcription returns null', async () => {
    const { processInboundMessage } = mockProcessorDeps('all', {
      isVoice: true,
      audioBuffer: Buffer.from([1]),
      transcript: null,
    });
    const { processWhatsAppRawMessage } = await import('../src/platforms/whatsapp/processor.js');

    await processWhatsAppRawMessage({ user: { id: 'bot@s.whatsapp.net' } } as never, {} as never);

    expect(processInboundMessage).toHaveBeenCalledTimes(1);
    expect(inboundArg(processInboundMessage)).toMatchObject({
      text: '[voice note]',
      synthesizedPlaceholder: true,
    });
  });

  it('uses the transcript with no placeholder flag when transcription succeeds', async () => {
    const { processInboundMessage } = mockProcessorDeps('all', {
      isVoice: true,
      audioBuffer: Buffer.from([1]),
      transcript: 'hello from voice',
    });
    const { processWhatsAppRawMessage } = await import('../src/platforms/whatsapp/processor.js');

    await processWhatsAppRawMessage({ user: { id: 'bot@s.whatsapp.net' } } as never, {} as never);

    const inbound = inboundArg(processInboundMessage);
    expect(inbound?.text).toBe('hello from voice');
    expect(inbound?.synthesizedPlaceholder).toBeUndefined();
    expect(inbound?.audio).toMatchObject({ buffer: Buffer.from([1]), ptt: true });
  });
});
