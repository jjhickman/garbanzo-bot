import { beforeEach, describe, expect, it, vi } from 'vitest';

interface HandlerMocks {
  setRetryHandler: ReturnType<typeof vi.fn>;
  getResponse: ReturnType<typeof vi.fn>;
  recordBotResponse: ReturnType<typeof vi.fn>;
  isGroupEnabled: ReturnType<typeof vi.fn>;
  buildWelcomeMessage: ReturnType<typeof vi.fn>;
  handleOwnerDM: ReturnType<typeof vi.fn>;
  markMessageReceived: ReturnType<typeof vi.fn>;
}

function mockHandlerDeps(): HandlerMocks {
  const setRetryHandler = vi.fn();
  const getResponse = vi.fn(async () => 'retry response');
  const recordBotResponse = vi.fn();
  const isGroupEnabled = vi.fn(() => true);
  const buildWelcomeMessage = vi.fn(() => 'welcome text');
  const handleOwnerDM = vi.fn(async () => undefined);
  const markMessageReceived = vi.fn();

  vi.doMock('@whiskeysockets/baileys', () => ({
    normalizeMessageContent: (content: unknown) => content,
  }));

  vi.doMock('../src/middleware/logger.js', () => ({
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  vi.doMock('../src/utils/config.js', () => ({
    PROJECT_ROOT: '/tmp',
    config: { OWNER_JID: 'owner@s.whatsapp.net', MESSAGING_PLATFORM: 'whatsapp' },
  }));

  vi.doMock('../src/utils/jid.js', () => ({
    isGroupJid: vi.fn((jid: string) => jid.endsWith('@g.us')),
    getSenderJid: vi.fn((_remoteJid: string, participant?: string) => participant ?? 'user@s.whatsapp.net'),
  }));

  vi.doMock('../src/core/groups-config.js', () => ({
    isGroupEnabled,
    isFeatureEnabled: vi.fn(() => true),
    getGroupName: vi.fn(() => 'General'),
    getEnabledGroupJidByName: vi.fn((name: string) => (name === 'Introductions' ? 'intro@g.us' : null)),
  }));

  vi.doMock('../src/features/welcome.js', () => ({ buildWelcomeMessage }));
  vi.doMock('../src/features/moderation.js', () => ({
    checkMessage: vi.fn(async () => null),
    formatModerationAlert: vi.fn(() => 'alert'),
    applyStrikeAndMute: vi.fn(() => ({ muted: false, dmMessage: null })),
  }));

  vi.doMock('../src/features/introductions.js', () => ({
    INTRODUCTIONS_JID: 'intro@g.us',
    handleIntroduction: vi.fn(async () => null),
  }));

  vi.doMock('../src/features/events.js', () => ({
    EVENTS_JID: 'events@g.us',
    handleEventPassive: vi.fn(async () => null),
  }));

  vi.doMock('../src/middleware/sanitize.js', () => ({
    sanitizeMessage: vi.fn((text: string) => ({ text, rejected: false })),
  }));

  vi.doMock('../src/utils/db.js', () => ({
    touchProfile: vi.fn(),
    updateActiveGroups: vi.fn(),
    logModeration: vi.fn(),
  }));

  vi.doMock('../src/middleware/context.js', () => ({ recordMessage: vi.fn() }));

  vi.doMock('../src/middleware/stats.js', () => ({
    recordGroupMessage: vi.fn(),
    recordModerationFlag: vi.fn(),
    recordBotResponse,
  }));

  vi.doMock('../src/middleware/retry.js', () => ({ setRetryHandler }));

  vi.doMock('../src/platforms/whatsapp/media.js', () => ({
    isVoiceMessage: vi.fn(() => false),
    downloadVoiceAudio: vi.fn(async () => null),
    hasVisualMedia: vi.fn(() => false),
    extractMedia: vi.fn(async () => null),
  }));

  vi.doMock('../src/features/voice.js', () => ({ transcribeAudio: vi.fn(async () => null) }));
  vi.doMock('../src/middleware/health.js', () => ({ markMessageReceived }));
  vi.doMock('../src/platforms/whatsapp/owner-commands.js', () => ({ handleOwnerDM }));
  vi.doMock('../src/platforms/whatsapp/group-handler.js', () => ({ handleGroupMessage: vi.fn(async () => undefined) }));
  vi.doMock('../src/platforms/whatsapp/reactions.js', () => ({
    isReplyToBot: vi.fn(() => false),
    isAcknowledgment: vi.fn(() => false),
  }));
  vi.doMock('../src/core/response-router.js', () => ({ getResponse }));

  return {
    setRetryHandler,
    getResponse,
    recordBotResponse,
    isGroupEnabled,
    buildWelcomeMessage,
    handleOwnerDM,
    markMessageReceived,
  };
}

describe('Handlers helper functions', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('extractText handles all supported message text fields', async () => {
    mockHandlerDeps();
    const { extractWhatsAppText: extractText } = await import('../src/platforms/whatsapp/inbound.js');

    expect(extractText({ conversation: 'hello' } as never)).toBe('hello');
    expect(extractText({ extendedTextMessage: { text: 'extended' } } as never)).toBe('extended');
    expect(extractText({ imageMessage: { caption: 'image cap' } } as never)).toBe('image cap');
    expect(extractText({ videoMessage: { caption: 'video cap' } } as never)).toBe('video cap');
    expect(extractText({ documentMessage: { caption: 'doc cap' } } as never)).toBe('doc cap');
    expect(extractText(undefined)).toBeNull();
  });

  it('extractQuotedText unwraps quoted text and returns undefined when absent', async () => {
    mockHandlerDeps();
    const { extractWhatsAppQuotedText: extractQuotedText } = await import('../src/platforms/whatsapp/inbound.js');

    const content = {
      extendedTextMessage: {
        contextInfo: {
          quotedMessage: {
            conversation: 'quoted hello',
          },
        },
      },
    };

    expect(extractQuotedText(content as never)).toBe('quoted hello');
    expect(extractQuotedText(undefined)).toBeUndefined();
  });

  it('extractMentionedJids reads mentions from different content types', async () => {
    mockHandlerDeps();
    const { extractWhatsAppMentionedJids: extractMentionedJids } = await import('../src/platforms/whatsapp/inbound.js');

    expect(extractMentionedJids({
      extendedTextMessage: { contextInfo: { mentionedJid: ['a@s.whatsapp.net'] } },
    } as never)).toEqual(['a@s.whatsapp.net']);

    expect(extractMentionedJids({
      imageMessage: { contextInfo: { mentionedJid: ['b@s.whatsapp.net'] } },
    } as never)).toEqual(['b@s.whatsapp.net']);

    expect(extractMentionedJids({
      videoMessage: { contextInfo: { mentionedJid: ['c@s.whatsapp.net'] } },
    } as never)).toEqual(['c@s.whatsapp.net']);

    expect(extractMentionedJids({
      documentMessage: { contextInfo: { mentionedJid: ['d@s.whatsapp.net'] } },
    } as never)).toEqual(['d@s.whatsapp.net']);

    expect(extractMentionedJids({ conversation: 'no mentions' } as never)).toBeUndefined();
  });
});

describe('registerHandlers wiring and edge branches', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('registers retry handler and sends retry response through socket', async () => {
    const mocks = mockHandlerDeps();
    const { registerWhatsAppHandlers: registerHandlers } = await import('../src/platforms/whatsapp/handlers.js');

    const handlers: Record<string, (payload: unknown) => Promise<void>> = {};
    const sock = {
      ev: {
        on: vi.fn((event: string, cb: (payload: unknown) => Promise<void>) => {
          handlers[event] = cb;
        }),
      },
      sendMessage: vi.fn(async () => ({ key: { id: 'out-1', remoteJid: 'g@g.us' } })),
      user: { id: 'bot@s.whatsapp.net', lid: undefined },
    };

    registerHandlers(sock as never);
    expect(mocks.setRetryHandler).toHaveBeenCalledTimes(1);

    const retryHandler = mocks.setRetryHandler.mock.calls[0]?.[0] as (entry: {
      groupJid: string;
      senderJid: string;
      query: string;
      timestamp: number;
    }) => Promise<void>;

    await retryHandler({
      groupJid: 'g@g.us',
      senderJid: 'user@s.whatsapp.net',
      query: 'hello retry',
      timestamp: Date.now(),
    });

    expect(mocks.getResponse).toHaveBeenCalled();
    expect(sock.sendMessage).toHaveBeenCalledWith('g@g.us', { text: 'retry response' });
    expect(mocks.recordBotResponse).toHaveBeenCalledWith('g@g.us');
    expect(handlers['messages.upsert']).toBeTypeOf('function');
    expect(handlers['group-participants.update']).toBeTypeOf('function');
  });

  it('sends welcome message for enabled groups on participant add', async () => {
    const mocks = mockHandlerDeps();
    const { registerWhatsAppHandlers: registerHandlers } = await import('../src/platforms/whatsapp/handlers.js');

    const handlers: Record<string, (payload: unknown) => Promise<void>> = {};
    const sock = {
      ev: {
        on: vi.fn((event: string, cb: (payload: unknown) => Promise<void>) => {
          handlers[event] = cb;
        }),
      },
      sendMessage: vi.fn(async () => ({ key: { id: 'out-2', remoteJid: 'group@g.us' } })),
      user: { id: 'bot@s.whatsapp.net', lid: undefined },
    };

    registerHandlers(sock as never);
    await handlers['group-participants.update']({
      id: 'group@g.us',
      action: 'add',
      participants: ['user1@s.whatsapp.net'],
    });

    expect(mocks.isGroupEnabled).toHaveBeenCalledWith('group@g.us');
    expect(mocks.buildWelcomeMessage).toHaveBeenCalledWith('group@g.us', ['user1@s.whatsapp.net']);
    expect(sock.sendMessage).toHaveBeenCalledWith('group@g.us', { text: 'welcome text' });
  });

  it('skips non-notify upserts except for Introductions group catch-up path', async () => {
    const mocks = mockHandlerDeps();
    const { registerWhatsAppHandlers: registerHandlers } = await import('../src/platforms/whatsapp/handlers.js');

    const handlers: Record<string, (payload: unknown) => Promise<void>> = {};
    const sock = {
      ev: {
        on: vi.fn((event: string, cb: (payload: unknown) => Promise<void>) => {
          handlers[event] = cb;
        }),
      },
      sendMessage: vi.fn(async () => ({ key: { id: 'out-3', remoteJid: 'group@g.us' } })),
      user: { id: 'bot@s.whatsapp.net', lid: undefined },
    };

    registerHandlers(sock as never);

    // non-intro group + non-notify -> skipped before handleMessage
    await handlers['messages.upsert']({
      type: 'append',
      messages: [{ key: { id: 'm1', remoteJid: 'general@g.us', fromMe: false }, message: { conversation: 'hello' } }],
    });

    // intro group + non-notify -> still processed by catch-up path
    await handlers['messages.upsert']({
      type: 'append',
      messages: [{ key: { id: 'm2', remoteJid: 'intro@g.us', fromMe: false }, message: { conversation: 'intro text' } }],
    });

    expect(mocks.markMessageReceived).toHaveBeenCalledTimes(1);
  });
});
