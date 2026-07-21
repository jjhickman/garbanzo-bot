process.env.MESSAGING_PLATFORM ??= 'telegram';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.TELEGRAM_OWNER_ID ??= '111';
process.env.TELEGRAM_BOT_TOKEN ??= 'test_tg_token';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageContext } from '../src/ai/persona.js';
import type { VisionImage } from '../src/core/vision.js';
import type { PlatformMessenger } from '../src/core/platform-messenger.js';

type FeaturePredicate = (chatId: string, feature: string) => boolean;
type MockGetResponse = (
  query: string,
  ctx: MessageContext,
  isFeatureEnabled: FeaturePredicate,
  visionImages?: VisionImage[],
) => Promise<string | null>;

// ── Unit: client maps reply_to_message attachments to quoted refs ───

describe('telegram client quoted attachment mapping', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function importClient() {
    return import('../src/platforms/telegram/client.js');
  }

  const baseMessage = {
    message_id: 10,
    date: 1_700_000_000,
    chat: { id: -100123, type: 'supergroup' as const },
    from: { id: 42, first_name: 'Ada' },
  };

  it('maps a replied-to voice note into quotedVoice metadata without downloading', async () => {
    const { mapTelegramMessageToPayload } = await importClient();

    const mapped = mapTelegramMessageToPayload({
      ...baseMessage,
      text: '@GarbanzoBot what did they say?',
      reply_to_message: {
        ...baseMessage,
        message_id: 9,
        voice: { file_id: 'voice-9', file_unique_id: 'u9', duration: 4, mime_type: 'audio/ogg' },
      },
    }, { id: 999, username: 'GarbanzoBot' });

    expect(mapped.quotedVoice).toEqual({ fileId: 'voice-9', mimeType: 'audio/ogg' });
    expect(mapped.quotedMedia).toBeUndefined();
  });

  it('maps a replied-to photo and document into quotedMedia metadata', async () => {
    const { mapTelegramMessageToPayload } = await importClient();

    const photoReply = mapTelegramMessageToPayload({
      ...baseMessage,
      text: '@GarbanzoBot what is this?',
      reply_to_message: {
        ...baseMessage,
        message_id: 8,
        photo: [{ file_id: 'photo-small', file_unique_id: 's', width: 90, height: 90 },
          { file_id: 'photo-big', file_unique_id: 'b', width: 800, height: 800 }],
      },
    }, { id: 999, username: 'GarbanzoBot' });
    expect(photoReply.quotedMedia).toMatchObject({ fileId: 'photo-big', mimeType: 'image/jpeg', kind: 'image' });

    const docReply = mapTelegramMessageToPayload({
      ...baseMessage,
      text: '@GarbanzoBot summarize that',
      reply_to_message: {
        ...baseMessage,
        message_id: 7,
        document: { file_id: 'doc-7', file_unique_id: 'd7', file_name: 'flyer.pdf', mime_type: 'application/pdf' },
      },
    }, { id: 999, username: 'GarbanzoBot' });
    expect(docReply.quotedMedia).toMatchObject({ fileId: 'doc-7', fileName: 'flyer.pdf', kind: 'document' });
  });

  it('maps a direct audio FILE (Bot API audio) into media kind audio, not voice', async () => {
    const { mapTelegramMessageToPayload } = await importClient();

    const mapped = mapTelegramMessageToPayload({
      ...baseMessage,
      audio: { file_id: 'song-1', file_unique_id: 'a1', duration: 180, mime_type: 'audio/mpeg', file_name: 'demo.mp3' },
    }, { id: 999, username: 'GarbanzoBot' });

    expect(mapped.media).toEqual({ fileId: 'song-1', mimeType: 'audio/mpeg', fileName: 'demo.mp3', kind: 'audio' });
    // The voice-note flow (processor resolveVoiceText) must stay untouched.
    expect(mapped.voice).toBeUndefined();
  });

  it('maps a replied-to audio FILE into quotedMedia kind audio', async () => {
    const { mapTelegramMessageToPayload } = await importClient();

    const mapped = mapTelegramMessageToPayload({
      ...baseMessage,
      text: '@GarbanzoBot what song is that?',
      reply_to_message: {
        ...baseMessage,
        message_id: 5,
        audio: { file_id: 'song-2', file_unique_id: 'a2', duration: 30, mime_type: 'audio/mp4', file_name: 'riff.m4a' },
      },
    }, { id: 999, username: 'GarbanzoBot' });

    expect(mapped.quotedMedia).toMatchObject({ fileId: 'song-2', mimeType: 'audio/mp4', fileName: 'riff.m4a', kind: 'audio' });
    expect(mapped.quotedVoice).toBeUndefined();
  });

  it('leaves quoted refs unset for a plain text reply', async () => {
    const { mapTelegramMessageToPayload } = await importClient();

    const mapped = mapTelegramMessageToPayload({
      ...baseMessage,
      text: 'just words',
      reply_to_message: { ...baseMessage, message_id: 6, text: 'earlier words' },
    }, { id: 999, username: 'GarbanzoBot' });

    expect(mapped.quotedVoice).toBeUndefined();
    expect(mapped.quotedMedia).toBeUndefined();
    expect(mapped.quotedText).toBe('earlier words');
  });
});

// ── Unit: Telegram collector ────────────────────────────────────────

describe('telegram attachment collector', () => {
  const downloadTelegramFile = vi.fn<(token: string, fileId: string, maxBytes: number) => Promise<Buffer | null>>();

  beforeEach(() => {
    vi.resetModules();
    downloadTelegramFile.mockReset();
    downloadTelegramFile.mockResolvedValue(Buffer.from('tg-bytes'));
    vi.doMock('../src/platforms/telegram/telegram-voice.js', () => ({ downloadTelegramFile }));
  });

  afterEach(() => {
    vi.doUnmock('../src/platforms/telegram/telegram-voice.js');
  });

  async function importCollector() {
    return import('../src/platforms/telegram/attachment-reading.js');
  }

  it('resolves telegram-file refs to bytes lazily via the token-safe downloader', async () => {
    const { collectTelegramAttachments } = await importCollector();

    const attachments = collectTelegramAttachments({
      quotedMedia: { url: 'telegram-file:photo-1', contentType: 'image/jpeg', fileName: 'photo.jpg', kind: 'image' },
    }, 'tok-123');

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ kind: 'image', contentType: 'image/jpeg' });
    expect(downloadTelegramFile).not.toHaveBeenCalled();

    await attachments[0].bytes();
    expect(downloadTelegramFile).toHaveBeenCalledWith('tok-123', 'photo-1', 8 * 1024 * 1024);
  });

  it('prefers an already-downloaded buffer and never re-fetches', async () => {
    const { collectTelegramAttachments } = await importCollector();

    const attachments = collectTelegramAttachments({
      media: { url: 'telegram-file:photo-2', contentType: 'image/jpeg', kind: 'image', buffer: Buffer.from('cached') },
    }, 'tok-123');

    expect(await attachments[0].bytes()).toEqual(Buffer.from('cached'));
    expect(downloadTelegramFile).not.toHaveBeenCalled();
  });

  it('maps media kind audio (an audio FILE) to a readable audio attachment with lazy bytes', async () => {
    const { collectTelegramAttachments } = await importCollector();

    const attachments = collectTelegramAttachments({
      media: { url: 'telegram-file:song-1', contentType: 'audio/mpeg', fileName: 'demo.mp3', kind: 'audio' },
    }, 'tok-123');

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ kind: 'audio', contentType: 'audio/mpeg', fileName: 'demo.mp3' });
    expect(downloadTelegramFile).not.toHaveBeenCalled();

    await attachments[0].bytes();
    expect(downloadTelegramFile).toHaveBeenCalledWith('tok-123', 'song-1', 8 * 1024 * 1024);
  });

  it('collects quoted voice as an audio attachment; direct voice stays with the processor', async () => {
    const { collectTelegramAttachments } = await importCollector();

    const attachments = collectTelegramAttachments({
      quotedAudio: { url: 'telegram-file:voice-1', contentType: 'audio/ogg', ptt: true },
    }, 'tok-123');

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ kind: 'audio', contentType: 'audio/ogg', ptt: true });
  });

  it('prefers the message own media over quoted attachments', async () => {
    const { collectTelegramAttachments } = await importCollector();

    const attachments = collectTelegramAttachments({
      media: { url: 'telegram-file:own', contentType: 'image/jpeg', kind: 'image' },
      quotedMedia: { url: 'telegram-file:q', contentType: 'image/jpeg', kind: 'image' },
      quotedAudio: { url: 'telegram-file:qa', contentType: 'audio/ogg' },
    }, 'tok-123');

    expect(attachments).toHaveLength(1);
    await attachments[0].bytes();
    expect(downloadTelegramFile).toHaveBeenCalledWith('tok-123', 'own', expect.any(Number));
  });

  it('yields null bytes for malformed refs or a missing token', async () => {
    const { collectTelegramAttachments, telegramFileIdFromRef } = await importCollector();

    expect(telegramFileIdFromRef('telegram-file:abc')).toBe('abc');
    expect(telegramFileIdFromRef('https://api.telegram.org/file/botX/abc')).toBeNull();
    expect(telegramFileIdFromRef(undefined)).toBeNull();

    const badRef = collectTelegramAttachments({
      quotedMedia: { url: 'https://evil.example/x.png', contentType: 'image/png', kind: 'image' },
    }, 'tok-123');
    expect(await badRef[0].bytes()).toBeNull();

    const noToken = collectTelegramAttachments({
      quotedMedia: { url: 'telegram-file:q', contentType: 'image/png', kind: 'image' },
    }, undefined);
    expect(await noToken[0].bytes()).toBeNull();
    expect(downloadTelegramFile).not.toHaveBeenCalled();
  });
});

// ── Wiring: processor reads attachments into the group dispatch ─────

describe('telegram processor attachment wiring', () => {
  const downloadTelegramFile = vi.fn<(token: string, fileId: string, maxBytes: number) => Promise<Buffer | null>>();
  const prepareForVision = vi.fn<(media: unknown) => Promise<VisionImage[]>>();
  const transcribeAudio = vi.fn<(buffer: Buffer, mime?: string) => Promise<string | null>>();
  let savedWhisperUrl: string | undefined;

  function createMessenger(): PlatformMessenger & { sendText: ReturnType<typeof vi.fn> } {
    const sendText = vi.fn<PlatformMessenger['sendText']>(async () => undefined);
    return {
      platform: 'telegram',
      sendText,
      sendPoll: vi.fn<PlatformMessenger['sendPoll']>(async () => undefined),
      sendTextWithRef: vi.fn<PlatformMessenger['sendTextWithRef']>(async (chatId) => ({
        platform: 'telegram', chatId, id: 'm1', ref: {},
      })),
      sendDocument: vi.fn<PlatformMessenger['sendDocument']>(async (chatId) => ({
        platform: 'telegram', chatId, id: 'd1', ref: {},
      })),
      sendAudio: vi.fn<PlatformMessenger['sendAudio']>(async () => undefined),
      deleteMessage: vi.fn<PlatformMessenger['deleteMessage']>(async () => undefined),
    };
  }

  function setupMocks() {
    const getResponse = vi.fn<MockGetResponse>(async () => 'ok');

    vi.doMock('../src/platforms/telegram/telegram-config.js', () => ({
      isTelegramChatEnabled: vi.fn(() => true),
      telegramChatRequiresMention: vi.fn(() => true),
      isTelegramFeatureEnabled: vi.fn(() => false),
      getTelegramChatName: vi.fn(() => 'general'),
    }));
    vi.doMock('../src/core/response-router.js', () => ({ getResponse }));
    vi.doMock('../src/platforms/telegram/telegram-voice.js', () => ({ downloadTelegramFile }));
    vi.doMock('../src/core/vision.js', () => ({ prepareForVision }));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));

    return { getResponse };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    downloadTelegramFile.mockReset();
    prepareForVision.mockReset();
    transcribeAudio.mockReset();
    savedWhisperUrl = process.env.WHISPER_URL;
    process.env.WHISPER_URL = 'http://whisper.test:8090';
  });

  afterEach(() => {
    if (savedWhisperUrl === undefined) delete process.env.WHISPER_URL;
    else process.env.WHISPER_URL = savedWhisperUrl;
    vi.doUnmock('../src/platforms/telegram/telegram-config.js');
    vi.doUnmock('../src/core/response-router.js');
    vi.doUnmock('../src/platforms/telegram/telegram-voice.js');
    vi.doUnmock('../src/core/vision.js');
    vi.doUnmock('../src/features/voice.js');
    vi.doUnmock('../src/bridge/capture-hook.js');
  });

  async function drive(event: Record<string, unknown>) {
    const { processTelegramEvent } = await import('../src/platforms/telegram/processor.js');
    const messenger = createMessenger();
    await processTelegramEvent(messenger, {
      messageId: 'msg-1',
      chatId: 'chat-1',
      isGroupChat: true,
      senderId: 'user-1',
      timestampMs: Date.now(),
      mentionedIds: ['999'],
      ...event,
    }, { ownerId: 'owner-chat', ownerUserId: '111', botUserId: '999', botUsername: 'GarbanzoBot' });
    return messenger;
  }

  it('feeds a QUOTED photo behind an engaged reply to vision', async () => {
    const { getResponse } = setupMocks();
    const images: VisionImage[] = [{ base64: 'cQ==', mediaType: 'image/jpeg' }];
    downloadTelegramFile.mockResolvedValue(Buffer.from('photo-bytes'));
    prepareForVision.mockResolvedValue(images);

    await drive({
      text: 'what is this?',
      quotedMedia: { url: 'telegram-file:photo-1', contentType: 'image/jpeg', fileName: 'photo.jpg', kind: 'image' },
    });

    expect(downloadTelegramFile).toHaveBeenCalledWith('test_tg_token', 'photo-1', expect.any(Number));
    expect(getResponse).toHaveBeenCalledWith(
      'what is this?',
      expect.anything(),
      expect.any(Function),
      images,
    );
  });

  it('appends the QUOTED voice transcript behind an engaged reply', async () => {
    const { getResponse } = setupMocks();
    downloadTelegramFile.mockResolvedValue(Buffer.from('voice-bytes'));
    transcribeAudio.mockResolvedValue('sound check at six');

    await drive({
      text: 'what did they say?',
      quotedAudio: { url: 'telegram-file:voice-1', contentType: 'audio/ogg', ptt: true },
    });

    expect(transcribeAudio).toHaveBeenCalledWith(Buffer.from('voice-bytes'), 'audio/ogg');
    expect(getResponse).toHaveBeenCalledWith(
      'what did they say?\n\n[voice message transcript] sound check at six',
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });

  it('adds a context line for a QUOTED document', async () => {
    const { getResponse } = setupMocks();

    await drive({
      text: 'summarize that',
      quotedMedia: { url: 'telegram-file:doc-1', contentType: 'application/pdf', fileName: 'flyer.pdf', kind: 'document' },
    });

    expect(downloadTelegramFile).not.toHaveBeenCalled();
    expect(getResponse).toHaveBeenCalledWith(
      'summarize that\n\n[attachment: flyer.pdf (application/pdf)]',
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });

  it('reads the message own photo (direct media) for vision', async () => {
    const { getResponse } = setupMocks();
    const images: VisionImage[] = [{ base64: 'ZA==', mediaType: 'image/jpeg' }];
    downloadTelegramFile.mockResolvedValue(Buffer.from('direct-bytes'));
    prepareForVision.mockResolvedValue(images);

    await drive({
      text: 'look at this',
      media: { url: 'telegram-file:photo-2', contentType: 'image/jpeg', fileName: 'photo.jpg', kind: 'image' },
    });

    expect(getResponse).toHaveBeenCalledWith('look at this', expect.anything(), expect.any(Function), images);
  });

  it('degrades a failed download to a context line', async () => {
    const { getResponse } = setupMocks();
    downloadTelegramFile.mockResolvedValue(null);

    await drive({
      text: 'can you see this?',
      quotedMedia: { url: 'telegram-file:photo-3', contentType: 'image/jpeg', fileName: 'photo.jpg', kind: 'image' },
    });

    expect(getResponse).toHaveBeenCalledWith(
      'can you see this?\n\n[attachment: photo.jpg (image/jpeg)]',
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });

  it('never reads attachments for unengaged messages or bang commands', async () => {
    const { getResponse } = setupMocks();

    // Unengaged in a require-mention chat: no reads, no dispatch.
    await drive({
      text: 'nice shot',
      mentionedIds: [],
      quotedMedia: { url: 'telegram-file:photo-4', contentType: 'image/jpeg', kind: 'image' },
    });
    expect(downloadTelegramFile).not.toHaveBeenCalled();
    expect(getResponse).not.toHaveBeenCalled();

    // Bang command: raw query preserved, no reads.
    await drive({
      text: '!weather boston',
      quotedMedia: { url: 'telegram-file:photo-5', contentType: 'image/jpeg', kind: 'image' },
    });
    expect(downloadTelegramFile).not.toHaveBeenCalled();
    expect(getResponse).toHaveBeenCalledWith('!weather boston', expect.anything(), expect.any(Function), undefined);
  });

  it('transcribes an ENGAGED captionless audio FILE and keeps it invisible to visual-media relay', async () => {
    const captureForBridge = vi.fn();
    vi.doMock('../src/bridge/capture-hook.js', () => ({ captureForBridge }));
    const { getResponse } = setupMocks();
    downloadTelegramFile.mockResolvedValue(Buffer.from('mp3-bytes'));
    transcribeAudio.mockResolvedValue('rough mix of the bridge');

    // Engaged via reply-to-bot (client.ts folds that into mentionedIds);
    // a captionless audio file has no text of its own.
    await drive({
      text: '',
      media: { url: 'telegram-file:song-1', contentType: 'audio/mpeg', fileName: 'demo.mp3', kind: 'audio' },
      mentionedIds: ['999'],
    });

    expect(downloadTelegramFile).toHaveBeenCalledWith('test_tg_token', 'song-1', expect.any(Number));
    expect(transcribeAudio).toHaveBeenCalledWith(Buffer.from('mp3-bytes'), 'audio/mpeg');
    expect(getResponse).toHaveBeenCalledWith(
      '[voice message transcript] rough mix of the bridge',
      expect.anything(),
      expect.any(Function),
      undefined,
    );

    // Bridge-visible shape: an audio FILE is NOT visual media (no `[image]`
    // placeholder relay) and rides `media` with kind 'audio'.
    const captured = captureForBridge.mock.calls[0]?.[0] as
      | { hasVisualMedia: boolean; media?: { kind: string } }
      | undefined;
    expect(captured?.hasVisualMedia).toBe(false);
    expect(captured?.media?.kind).toBe('audio');
  });

  it('does not regress the direct voice flow (transcript-as-text, no attachment read)', async () => {
    const { getResponse } = setupMocks();
    transcribeAudio.mockResolvedValue('direct voice transcript');

    await drive({
      text: '',
      audio: { url: 'telegram-file:voice-2', contentType: 'audio/ogg', buffer: Buffer.from([1, 2, 3]), ptt: true },
      mentionedIds: ['999'],
    });

    // resolveVoiceText transcribed the direct voice into the message text;
    // the attachment reader must not transcribe it a second time.
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(downloadTelegramFile).not.toHaveBeenCalled();
    expect(getResponse).toHaveBeenCalledWith('direct voice transcript', expect.anything(), expect.any(Function), undefined);
  });
});
