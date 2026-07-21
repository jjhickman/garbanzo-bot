process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VisionImage } from '../src/core/vision.js';

// Realistic-enough Baileys pure helpers for crafted message contents.
function fakeGetContentType(content: Record<string, unknown>): string | null {
  for (const key of ['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage']) {
    if (content[key] !== undefined) return key;
  }
  return null;
}

function mockBaileys() {
  vi.doMock('@whiskeysockets/baileys', () => ({
    getContentType: vi.fn(fakeGetContentType),
    normalizeMessageContent: vi.fn((content: unknown) => content),
    downloadMediaMessage: vi.fn(async () => Buffer.from('unused')),
  }));
}

// ── Unit: WhatsApp collector ────────────────────────────────────────

describe('whatsapp attachment collector', () => {
  const downloadBoundedWhatsAppMedia = vi.fn<(msg: unknown, maxBytes: number) => Promise<Buffer | null>>();

  beforeEach(() => {
    vi.resetModules();
    downloadBoundedWhatsAppMedia.mockReset();
    downloadBoundedWhatsAppMedia.mockResolvedValue(Buffer.from('media-bytes'));
    mockBaileys();
    vi.doMock('../src/platforms/whatsapp/media.js', () => ({ downloadBoundedWhatsAppMedia }));
  });

  afterEach(() => {
    vi.doUnmock('@whiskeysockets/baileys');
    vi.doUnmock('../src/platforms/whatsapp/media.js');
  });

  async function importCollector() {
    return import('../src/platforms/whatsapp/attachment-reading.js');
  }

  it('collects a direct image with its caption and lazy bounded bytes', async () => {
    const { collectWhatsAppAttachments } = await importCollector();
    const msg = {
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: { imageMessage: { mimetype: 'image/png', caption: 'look at this' } },
    };

    const attachments = collectWhatsAppAttachments(msg as never);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ kind: 'image', contentType: 'image/png', caption: 'look at this' });
    expect(downloadBoundedWhatsAppMedia).not.toHaveBeenCalled();

    await attachments[0].bytes();
    expect(downloadBoundedWhatsAppMedia).toHaveBeenCalledWith(msg, 8 * 1024 * 1024);
  });

  it('collects direct non-PTT audio but skips direct PTT (already transcribed inline)', async () => {
    const { collectWhatsAppAttachments } = await importCollector();

    const mp3 = collectWhatsAppAttachments({
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: { audioMessage: { mimetype: 'audio/mpeg', ptt: false } },
    } as never);
    expect(mp3).toHaveLength(1);
    expect(mp3[0]).toMatchObject({ kind: 'audio', contentType: 'audio/mpeg', ptt: false });

    const ptt = collectWhatsAppAttachments({
      key: { id: 'm2', remoteJid: 'group@g.us' },
      message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } },
    } as never);
    expect(ptt).toEqual([]);
  });

  it('collects the QUOTED image behind a text reply, downloading via the quoted stanza', async () => {
    const { collectWhatsAppAttachments } = await importCollector();
    const msg = {
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: {
        extendedTextMessage: {
          text: '@garbanzo what is this?',
          contextInfo: {
            stanzaId: 'quoted-1',
            quotedMessage: { imageMessage: { mimetype: 'image/jpeg', caption: 'sunset' } },
          },
        },
      },
    };

    const attachments = collectWhatsAppAttachments(msg as never);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ kind: 'image', contentType: 'image/jpeg', caption: 'sunset' });

    await attachments[0].bytes();
    expect(downloadBoundedWhatsAppMedia).toHaveBeenCalledWith(
      expect.objectContaining({ key: { id: 'quoted-1', remoteJid: 'group@g.us' } }),
      8 * 1024 * 1024,
    );
  });

  it('collects QUOTED audio — PTT or not — behind a text reply', async () => {
    const { collectWhatsAppAttachments } = await importCollector();

    const attachments = collectWhatsAppAttachments({
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: {
        extendedTextMessage: {
          text: '@garbanzo what did they say?',
          contextInfo: {
            stanzaId: 'quoted-2',
            quotedMessage: { audioMessage: { mimetype: 'audio/ogg', ptt: true } },
          },
        },
      },
    } as never);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ kind: 'audio', contentType: 'audio/ogg', ptt: true });
  });

  it('collects a QUOTED document with its fileName', async () => {
    const { collectWhatsAppAttachments } = await importCollector();

    const attachments = collectWhatsAppAttachments({
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: {
        extendedTextMessage: {
          text: '@garbanzo summarize that',
          contextInfo: {
            stanzaId: 'quoted-3',
            quotedMessage: { documentMessage: { mimetype: 'application/pdf', fileName: 'flyer.pdf' } },
          },
        },
      },
    } as never);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ kind: 'document', contentType: 'application/pdf', fileName: 'flyer.pdf' });
  });

  it('prefers the message own media over the quoted media', async () => {
    const { collectWhatsAppAttachments } = await importCollector();

    const attachments = collectWhatsAppAttachments({
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: {
        imageMessage: {
          mimetype: 'image/png',
          caption: 'mine',
          contextInfo: {
            stanzaId: 'quoted-4',
            quotedMessage: { imageMessage: { mimetype: 'image/jpeg', caption: 'theirs' } },
          },
        },
      },
    } as never);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ caption: 'mine' });
  });

  it('collects nothing for plain text messages', async () => {
    const { collectWhatsAppAttachments } = await importCollector();
    expect(collectWhatsAppAttachments({
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: { conversation: 'hello' },
    } as never)).toEqual([]);
  });
});

// ── Wiring: group-handler reads attachments into the dispatch ───────

describe('whatsapp group-handler attachment wiring', () => {
  const downloadBoundedWhatsAppMedia = vi.fn<(msg: unknown, maxBytes: number) => Promise<Buffer | null>>();
  const prepareForVision = vi.fn<(media: unknown) => Promise<VisionImage[]>>();
  const transcribeAudio = vi.fn<(buffer: Buffer, mime?: string) => Promise<string | null>>();
  const processGroupMessage = vi.fn(async () => undefined);
  let savedWhisperUrl: string | undefined;

  function setupMocks(options: { requiresMention?: boolean } = {}) {
    mockBaileys();
    vi.doMock('../src/platforms/whatsapp/media.js', () => ({ downloadBoundedWhatsAppMedia }));
    vi.doMock('../src/core/vision.js', () => ({ prepareForVision }));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));
    vi.doMock('../src/core/process-group-message.js', () => ({ processGroupMessage }));
    vi.doMock('../src/core/response-router.js', () => ({ getResponse: vi.fn(async () => 'ok') }));
    vi.doMock('../src/platforms/whatsapp/adapter.js', () => ({
      createWhatsAppAdapter: vi.fn(() => ({ platform: 'whatsapp' })),
    }));
    vi.doMock('../src/utils/config.js', () => ({
      config: { OWNER_JID: 'owner@s.whatsapp.net', MESSAGING_PLATFORM: 'whatsapp' },
    }));
    vi.doMock('../src/core/groups-config.js', () => ({
      MENTION_PATTERNS: ['@garbanzo'],
      requiresMention: vi.fn(() => options.requiresMention ?? true),
      getGroupName: vi.fn(() => 'General'),
      isFeatureEnabled: vi.fn(() => true),
    }));
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
  }

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    downloadBoundedWhatsAppMedia.mockReset();
    prepareForVision.mockReset();
    transcribeAudio.mockReset();
    processGroupMessage.mockClear();
    savedWhisperUrl = process.env.WHISPER_URL;
    process.env.WHISPER_URL = 'http://whisper.test:8090';
  });

  afterEach(() => {
    if (savedWhisperUrl === undefined) delete process.env.WHISPER_URL;
    else process.env.WHISPER_URL = savedWhisperUrl;
  });

  const sock = { user: { id: 'bot@s.whatsapp.net', lid: 'bot@lid' } };

  async function drive(msg: Record<string, unknown>, text: string) {
    const { handleGroupMessage } = await import('../src/platforms/whatsapp/group-handler.js');
    const content = (msg as { message?: unknown }).message;
    await handleGroupMessage(sock as never, msg as never, 'group@g.us', 'user@s.whatsapp.net', text, content as never);
  }

  function dispatched(): { query: string; visionImages?: VisionImage[] } {
    expect(processGroupMessage).toHaveBeenCalledTimes(1);
    return processGroupMessage.mock.calls[0]?.[0] as never;
  }

  it('feeds the QUOTED image behind a text mention to vision', async () => {
    setupMocks();
    const images: VisionImage[] = [{ base64: 'cQ==', mediaType: 'image/jpeg' }];
    downloadBoundedWhatsAppMedia.mockResolvedValue(Buffer.from('quoted-image'));
    prepareForVision.mockResolvedValue(images);

    await drive({
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: {
        extendedTextMessage: {
          text: '@garbanzo what is this?',
          contextInfo: {
            stanzaId: 'q1',
            quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } },
          },
        },
      },
    }, '@garbanzo what is this?');

    const call = dispatched();
    expect(call.visionImages).toEqual(images);
    expect(call.query).toBe('what is this?');
  });

  it('appends the QUOTED voice note transcript behind a text mention', async () => {
    setupMocks();
    downloadBoundedWhatsAppMedia.mockResolvedValue(Buffer.from('quoted-voice'));
    transcribeAudio.mockResolvedValue('rehearsal moved to friday');

    await drive({
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: {
        extendedTextMessage: {
          text: '@garbanzo what did they say?',
          contextInfo: {
            stanzaId: 'q2',
            quotedMessage: { audioMessage: { mimetype: 'audio/ogg', ptt: true } },
          },
        },
      },
    }, '@garbanzo what did they say?');

    expect(transcribeAudio).toHaveBeenCalledWith(Buffer.from('quoted-voice'), 'audio/ogg');
    expect(dispatched().query).toBe('what did they say?\n\n[voice message transcript] rehearsal moved to friday');
  });

  it('adds a context line for a QUOTED document', async () => {
    setupMocks();

    await drive({
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: {
        extendedTextMessage: {
          text: '@garbanzo summarize that',
          contextInfo: {
            stanzaId: 'q3',
            quotedMessage: { documentMessage: { mimetype: 'application/pdf', fileName: 'flyer.pdf' } },
          },
        },
      },
    }, '@garbanzo summarize that');

    expect(dispatched().query).toBe('summarize that\n\n[attachment: flyer.pdf (application/pdf)]');
    expect(downloadBoundedWhatsAppMedia).not.toHaveBeenCalled();
  });

  it('transcribes direct non-PTT audio in a no-mention-required group', async () => {
    setupMocks({ requiresMention: false });
    downloadBoundedWhatsAppMedia.mockResolvedValue(Buffer.from('mp3-bytes'));
    transcribeAudio.mockResolvedValue('demo riff in e minor');

    await drive({
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: { audioMessage: { mimetype: 'audio/mpeg', ptt: false } },
    }, '');

    expect(dispatched().query).toBe('[voice message transcript] demo riff in e minor');
  });

  it('degrades a failed quoted download to a context line', async () => {
    setupMocks();
    downloadBoundedWhatsAppMedia.mockResolvedValue(null);

    await drive({
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: {
        extendedTextMessage: {
          text: '@garbanzo can you see this?',
          contextInfo: {
            stanzaId: 'q4',
            quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } },
          },
        },
      },
    }, '@garbanzo can you see this?');

    const call = dispatched();
    expect(call.visionImages).toBeUndefined();
    expect(call.query).toBe('can you see this?\n\n[attachment: file (image/jpeg)]');
  });

  it('never reads attachments for bang commands or unengaged messages', async () => {
    setupMocks();

    // Bang command: `!idea` semantics unchanged, raw query preserved.
    await drive({
      key: { id: 'm1', remoteJid: 'group@g.us' },
      message: {
        extendedTextMessage: {
          text: '!voice',
          contextInfo: {
            stanzaId: 'q5',
            quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } },
          },
        },
      },
    }, '!voice');
    expect(downloadBoundedWhatsAppMedia).not.toHaveBeenCalled();
    expect(dispatched().query).toBe('!voice');

    processGroupMessage.mockClear();

    // Unengaged in a require-mention group: no dispatch, no reads.
    await drive({
      key: { id: 'm2', remoteJid: 'group@g.us' },
      message: {
        extendedTextMessage: {
          text: 'nice shot',
          contextInfo: {
            stanzaId: 'q6',
            quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } },
          },
        },
      },
    }, 'nice shot');
    expect(processGroupMessage).not.toHaveBeenCalled();
    expect(downloadBoundedWhatsAppMedia).not.toHaveBeenCalled();
  });
});

// ── Processor: direct non-PTT audio reaches the group path ──────────

describe('whatsapp processor non-PTT audio surfacing', () => {
  function makeInbound(overrides: Record<string, unknown> = {}) {
    return {
      platform: 'whatsapp',
      chatId: 'group@g.us',
      senderId: 'user@s.whatsapp.net',
      messageId: 'm1',
      fromSelf: false,
      isStatusBroadcast: false,
      isGroupChat: true,
      timestampMs: Date.now(),
      text: null,
      hasVisualMedia: false,
      waMessage: { key: { id: 'm1', remoteJid: 'group@g.us' } },
      content: undefined,
      raw: {},
      ...overrides,
    };
  }

  function setupProcessorMocks(options: {
    directAudio?: { contentType: string; ptt: boolean } | null;
    inbound?: Record<string, unknown>;
  } = {}) {
    const processInboundMessage = vi.fn(async () => undefined);
    const transcribeAudio = vi.fn(async () => 'should not run');

    // The group-handler describe above leaves a partial Baileys mock
    // registered; the processor's RSVP intercept needs the real module
    // (proto/crypto helpers), so drop it here.
    vi.doUnmock('@whiskeysockets/baileys');
    vi.doMock('../src/core/process-inbound-message.js', () => ({ processInboundMessage }));
    vi.doMock('../src/utils/config.js', () => ({
      // DB_DIALECT: the processor's RSVP intercept imports the db layer,
      // whose schema module asserts the dialect at import time.
      config: { OWNER_JID: 'owner@s.whatsapp.net', MESSAGING_PLATFORM: 'whatsapp', WHATSAPP_CHAT_SCOPE: 'all', DB_DIALECT: 'sqlite' },
    }));
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../src/middleware/health.js', () => ({ markMessageReceived: vi.fn() }));
    vi.doMock('../src/platforms/whatsapp/media.js', () => ({
      isVoiceMessage: vi.fn(() => options.directAudio?.ptt === true),
      classifyDirectAudio: vi.fn(() => options.directAudio ?? null),
      downloadVoiceAudio: vi.fn(async () => null),
    }));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));
    vi.doMock('../src/features/introductions.js', () => ({ handleIntroduction: vi.fn(async () => null) }));
    vi.doMock('../src/features/events.js', () => ({ handleEventPassive: vi.fn(async () => null) }));
    vi.doMock('../src/core/groups-config.js', () => ({
      isGroupEnabled: vi.fn(() => true),
      getEnabledGroupJidByName: vi.fn(() => null),
    }));
    vi.doMock('../src/platforms/whatsapp/owner-commands.js', () => ({ handleOwnerDM: vi.fn(async () => undefined) }));
    vi.doMock('../src/platforms/whatsapp/group-handler.js', () => ({ handleGroupMessage: vi.fn(async () => undefined) }));
    vi.doMock('../src/platforms/whatsapp/reactions.js', () => ({
      isReplyToBot: vi.fn(() => false),
      isAcknowledgment: vi.fn(() => false),
    }));
    vi.doMock('../src/platforms/whatsapp/inbound.js', () => ({
      normalizeWhatsAppInboundMessage: vi.fn(() => makeInbound(options.inbound)),
    }));
    vi.doMock('../src/platforms/whatsapp/adapter.js', () => ({
      createWhatsAppAdapter: vi.fn(() => ({ sendText: vi.fn(async () => undefined) })),
    }));
    vi.doMock('../src/platforms/whatsapp/outbound-safety.js', () => ({
      getWhatsAppOutboundSafety: vi.fn(() => undefined),
    }));
    vi.doMock('../src/bridge/capture-hook.js', () => ({ captureForBridge: vi.fn() }));

    return { processInboundMessage, transcribeAudio };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function inboundArg(processInboundMessage: ReturnType<typeof vi.fn>) {
    return processInboundMessage.mock.calls[0]?.[1] as {
      audio?: { url: string; contentType: string; ptt?: boolean };
      hasReadableAttachment?: boolean;
    } | undefined;
  }

  it('marks direct non-PTT audio readable WITHOUT a synthetic audio ref, download, or transcription', async () => {
    const { processInboundMessage, transcribeAudio } = setupProcessorMocks({
      directAudio: { contentType: 'audio/mpeg', ptt: false },
    });
    const { processWhatsAppRawMessage } = await import('../src/platforms/whatsapp/processor.js');

    await processWhatsAppRawMessage({ user: { id: 'bot@s.whatsapp.net' } } as never, {} as never);

    const arg = inboundArg(processInboundMessage);
    expect(arg?.hasReadableAttachment).toBe(true);
    // A synthetic `audio` ref would leak into bridge capture as a spurious
    // `[voice note]` relay (and an unfetchable whatsapp-message: URL) — the
    // attachment collector reads bytes off the raw WAMessage instead.
    expect(arg?.audio).toBeUndefined();
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('does not mark non-PTT audio readable for DM chats', async () => {
    const { processInboundMessage } = setupProcessorMocks({
      directAudio: { contentType: 'audio/mpeg', ptt: false },
      inbound: { chatId: 'user@s.whatsapp.net', isGroupChat: false },
    });
    const { processWhatsAppRawMessage } = await import('../src/platforms/whatsapp/processor.js');

    await processWhatsAppRawMessage({ user: { id: 'bot@s.whatsapp.net' } } as never, {} as never);

    const arg = inboundArg(processInboundMessage);
    expect(arg?.audio).toBeUndefined();
    expect(arg?.hasReadableAttachment).toBeUndefined();
  });

  it('leaves plain text messages untouched', async () => {
    const { processInboundMessage } = setupProcessorMocks({
      directAudio: null,
      inbound: { text: 'hello' },
    });
    const { processWhatsAppRawMessage } = await import('../src/platforms/whatsapp/processor.js');

    await processWhatsAppRawMessage({ user: { id: 'bot@s.whatsapp.net' } } as never, {} as never);

    const arg = inboundArg(processInboundMessage);
    expect(arg?.audio).toBeUndefined();
    expect(arg?.hasReadableAttachment).toBeUndefined();
  });
});

// ── Core gate: hasReadableAttachment reaches group dispatch ─────────

describe('core gate for readable attachments', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    // The processor describe above stubs the core pipeline — this describe
    // exercises the REAL core gate.
    vi.doUnmock('../src/core/process-inbound-message.js');

    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../src/features/moderation.js', () => ({
      checkMessage: vi.fn(async () => null),
      formatModerationAlert: vi.fn(() => 'ALERT'),
      applyStrikeAndMute: vi.fn(() => ({ muted: false, dmMessage: null })),
    }));
    vi.doMock('../src/middleware/sanitize.js', () => ({
      sanitizeMessage: vi.fn((t: string) => ({ text: t, rejected: false })),
    }));
    vi.doMock('../src/utils/db.js', () => ({
      touchProfile: vi.fn(async () => undefined),
      updateActiveGroups: vi.fn(async () => undefined),
      logModeration: vi.fn(async () => undefined),
      getStrikeCount: vi.fn(async () => 0),
    }));
    vi.doMock('../src/middleware/context.js', () => ({ recordMessage: vi.fn(async () => undefined) }));
    vi.doMock('../src/middleware/stats.js', () => ({
      recordGroupMessage: vi.fn(),
      recordModerationFlag: vi.fn(),
    }));
  });

  function makeInbound(overrides: Record<string, unknown> = {}) {
    return {
      platform: 'whatsapp',
      chatId: 'group@g.us',
      senderId: 'user@s.whatsapp.net',
      messageId: 'm1',
      fromSelf: false,
      isStatusBroadcast: false,
      isGroupChat: true,
      timestampMs: Date.now(),
      text: null,
      hasVisualMedia: false,
      raw: { platform: 'whatsapp', chatId: 'group@g.us', id: 'm1' },
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
    };
  }

  const env = () => ({
    ownerId: 'owner@s.whatsapp.net',
    isGroupEnabled: () => true,
    introductionsChatId: null,
    eventsChatId: null,
    handleIntroduction: vi.fn(async () => null),
    handleEventPassive: vi.fn(async () => null),
  });

  it('lets a textless message with hasReadableAttachment reach the group handler', async () => {
    const { processInboundMessage } = await import('../src/core/process-inbound-message.js');
    const hooks = makeHooks();

    await processInboundMessage(
      { sendText: vi.fn(async () => undefined) } as never,
      makeInbound({ hasReadableAttachment: true }) as never,
      hooks as never,
      env() as never,
    );

    expect(hooks.handleGroupMessage).toHaveBeenCalledTimes(1);
  });

  it('still drops a textless message without any attachment marker', async () => {
    const { processInboundMessage } = await import('../src/core/process-inbound-message.js');
    const hooks = makeHooks();

    await processInboundMessage(
      { sendText: vi.fn(async () => undefined) } as never,
      makeInbound() as never,
      hooks as never,
      env() as never,
    );

    expect(hooks.handleGroupMessage).not.toHaveBeenCalled();
  });
});
