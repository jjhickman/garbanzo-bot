process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageContext } from '../src/ai/persona.js';
import type { VisionImage } from '../src/core/vision.js';
import type { DiscordDemoOutboxEntry } from '../src/platforms/discord/adapter.js';

type FeaturePredicate = (chatId: string, feature: string) => boolean;
type MockGetResponse = (
  query: string,
  ctx: MessageContext,
  isFeatureEnabled: FeaturePredicate,
  visionImages?: VisionImage[],
) => Promise<string | null>;

// ── Unit: attachment-reading helpers ────────────────────────────────

describe('discord attachment-reading helpers', () => {
  const fetchBoundedBuffer = vi.fn<(url: string, options: unknown) => Promise<Buffer | null>>();
  const prepareForVision = vi.fn<(media: unknown) => Promise<VisionImage[]>>();
  const transcribeAudio = vi.fn<(buffer: Buffer, mime?: string) => Promise<string | null>>();
  let savedWhisperUrl: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    fetchBoundedBuffer.mockReset();
    prepareForVision.mockReset();
    transcribeAudio.mockReset();
    savedWhisperUrl = process.env.WHISPER_URL;

    vi.doMock('../src/utils/bounded-fetch.js', () => ({ fetchBoundedBuffer }));
    vi.doMock('../src/core/vision.js', () => ({ prepareForVision }));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));
  });

  afterEach(() => {
    if (savedWhisperUrl === undefined) delete process.env.WHISPER_URL;
    else process.env.WHISPER_URL = savedWhisperUrl;
    vi.doUnmock('../src/utils/bounded-fetch.js');
    vi.doUnmock('../src/core/vision.js');
    vi.doUnmock('../src/features/voice.js');
  });

  async function importHelpers() {
    return import('../src/platforms/discord/attachment-reading.js');
  }

  it('prepares an image attachment for vision with the query as caption', async () => {
    fetchBoundedBuffer.mockResolvedValue(Buffer.from('img-bytes'));
    prepareForVision.mockResolvedValue([{ base64: 'aW1n', mediaType: 'image/png' }]);
    const { prepareDiscordVision } = await importHelpers();

    const images = await prepareDiscordVision(
      { url: 'https://cdn.example/x.png', contentType: 'image/png', fileName: 'x.png', kind: 'image' },
      'what is this?',
    );

    expect(images).toEqual([{ base64: 'aW1n', mediaType: 'image/png' }]);
    expect(prepareForVision).toHaveBeenCalledWith({
      type: 'image',
      data: Buffer.from('img-bytes'),
      mimeType: 'image/png',
      caption: 'what is this?',
    });
  });

  it('maps gifs and videos to their vision types', async () => {
    fetchBoundedBuffer.mockResolvedValue(Buffer.from('bytes'));
    prepareForVision.mockResolvedValue([{ base64: 'eA==', mediaType: 'image/gif' }]);
    const { prepareDiscordVision } = await importHelpers();

    await prepareDiscordVision(
      { url: 'https://cdn.example/x.gif', contentType: 'image/gif', kind: 'image' },
      '',
    );
    expect(prepareForVision).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'gif', caption: undefined }));

    await prepareDiscordVision(
      { url: 'https://cdn.example/x.mp4', contentType: 'video/mp4', kind: 'video' },
      '',
    );
    expect(prepareForVision).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'video' }));
  });

  it('returns undefined for documents, missing urls, and failed downloads', async () => {
    const { prepareDiscordVision } = await importHelpers();

    expect(await prepareDiscordVision(
      { url: 'https://cdn.example/x.pdf', contentType: 'application/pdf', kind: 'document' },
      'q',
    )).toBeUndefined();
    expect(fetchBoundedBuffer).not.toHaveBeenCalled();

    expect(await prepareDiscordVision(
      { contentType: 'image/png', kind: 'image' },
      'q',
    )).toBeUndefined();

    fetchBoundedBuffer.mockResolvedValue(null);
    expect(await prepareDiscordVision(
      { url: 'https://cdn.example/x.png', contentType: 'image/png', kind: 'image' },
      'q',
    )).toBeUndefined();
  });

  it('describes unreadable attachments with fileName and contentType', async () => {
    const { attachmentContextLine } = await importHelpers();
    expect(attachmentContextLine({ url: 'u', contentType: 'application/pdf', fileName: 'tabs.pdf', kind: 'document' }))
      .toBe('[attachment: tabs.pdf (application/pdf)]');
    expect(attachmentContextLine({ url: 'u', contentType: 'video/webm', kind: 'video' }))
      .toBe('[attachment: file (video/webm)]');
  });

  it('skips transcription entirely without an explicit WHISPER_URL', async () => {
    delete process.env.WHISPER_URL;
    const { transcribeDiscordAttachment } = await importHelpers();

    expect(await transcribeDiscordAttachment({ url: 'https://cdn.example/v.ogg', contentType: 'audio/ogg' })).toBeNull();
    expect(fetchBoundedBuffer).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('transcribes a fetched audio attachment and trims the result', async () => {
    process.env.WHISPER_URL = 'http://whisper.test:8090';
    fetchBoundedBuffer.mockResolvedValue(Buffer.from('voice-bytes'));
    transcribeAudio.mockResolvedValue('  count us in  ');
    const { transcribeDiscordAttachment } = await importHelpers();

    expect(await transcribeDiscordAttachment({ url: 'https://cdn.example/v.ogg', contentType: 'audio/ogg' }))
      .toBe('count us in');
    expect(transcribeAudio).toHaveBeenCalledWith(Buffer.from('voice-bytes'), 'audio/ogg');
  });

  it('degrades to null when transcription fails or is empty', async () => {
    process.env.WHISPER_URL = 'http://whisper.test:8090';
    fetchBoundedBuffer.mockResolvedValue(Buffer.from('voice-bytes'));
    transcribeAudio.mockResolvedValue('   ');
    const { transcribeDiscordAttachment } = await importHelpers();
    expect(await transcribeDiscordAttachment({ url: 'https://cdn.example/v.ogg', contentType: 'audio/ogg' })).toBeNull();

    transcribeAudio.mockRejectedValue(new Error('whisper down'));
    expect(await transcribeDiscordAttachment({ url: 'https://cdn.example/v.ogg', contentType: 'audio/ogg' })).toBeNull();
  });
});

// ── Wiring: processor passes vision/transcript into the group dispatch ──

describe('discord processor attachment wiring', () => {
  const prepareDiscordVision = vi.fn<(media: unknown, caption: string) => Promise<VisionImage[] | undefined>>();
  const transcribeDiscordAttachment = vi.fn<(audio: unknown) => Promise<string | null>>();

  function setupMocks() {
    const getResponse = vi.fn<MockGetResponse>(async () => 'ok');

    vi.doMock('../src/platforms/discord/discord-config.js', () => ({
      isDiscordChannelEnabled: vi.fn(() => true),
      discordChannelRequiresMention: vi.fn(() => true),
      isDiscordFeatureEnabled: vi.fn(() => false),
      isBandMember: vi.fn(() => false),
      getDiscordChannelName: vi.fn(() => 'songwriting'),
      getDiscordIntroductionsChannelId: vi.fn(() => null),
      getDiscordEventsChannelId: vi.fn(() => null),
    }));
    vi.doMock('../src/core/response-router.js', () => ({ getResponse }));
    vi.doMock('../src/platforms/discord/attachment-reading.js', () => ({
      prepareDiscordVision,
      transcribeDiscordAttachment,
      attachmentContextLine: (media: { fileName?: string; contentType: string }) =>
        `[attachment: ${media.fileName ?? 'file'} (${media.contentType})]`,
    }));

    return { getResponse };
  }

  beforeEach(() => {
    vi.resetModules();
    prepareDiscordVision.mockReset();
    transcribeDiscordAttachment.mockReset();
  });

  afterEach(() => {
    vi.doUnmock('../src/platforms/discord/discord-config.js');
    vi.doUnmock('../src/core/response-router.js');
    vi.doUnmock('../src/platforms/discord/attachment-reading.js');
  });

  async function drive(event: Record<string, unknown>): Promise<DiscordDemoOutboxEntry[]> {
    const adapterModule = await import('../src/platforms/discord/adapter.js');
    const processorModule = await import('../src/platforms/discord/processor.js');
    const outbox: DiscordDemoOutboxEntry[] = [];
    const messenger = adapterModule.createDiscordDemoAdapter(outbox);
    await processorModule.processDiscordEvent(
      messenger,
      {
        id: 'message-1',
        channel_id: 'chan-1',
        guild_id: 'guild-1',
        author: { id: 'user-1' },
        timestamp: new Date().toISOString(),
        mentions: [{ id: 'bot-user' }],
        ...event,
      },
      { ownerId: 'owner-dm', ownerUserId: 'owner-user', botUserId: 'bot-user' },
    );
    return outbox;
  }

  it('passes prepared vision images through to the assistant call', async () => {
    const { getResponse } = setupMocks();
    const images: VisionImage[] = [{ base64: 'aW1n', mediaType: 'image/png' }];
    prepareDiscordVision.mockResolvedValue(images);

    await drive({
      content: '<@bot-user> what do you think of this?',
      media: { url: 'https://cdn.example/x.png', contentType: 'image/png', fileName: 'x.png', kind: 'image' },
    });

    expect(prepareDiscordVision).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/png' }),
      'what do you think of this?',
    );
    expect(getResponse).toHaveBeenCalledWith(
      'what do you think of this?',
      expect.anything(),
      expect.anything(),
      images,
    );
  });

  it('appends a context line when the attachment cannot be read', async () => {
    const { getResponse } = setupMocks();
    prepareDiscordVision.mockResolvedValue(undefined);

    await drive({
      content: '<@bot-user> can you check this?',
      media: { url: 'https://cdn.example/tabs.pdf', contentType: 'application/pdf', fileName: 'tabs.pdf', kind: 'document' },
    });

    expect(getResponse).toHaveBeenCalledWith(
      'can you check this?\n\n[attachment: tabs.pdf (application/pdf)]',
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it('appends the voice transcript to the query', async () => {
    const { getResponse } = setupMocks();
    transcribeDiscordAttachment.mockResolvedValue('one two three four');

    await drive({
      content: '<@bot-user> thoughts?',
      audio: { url: 'https://cdn.example/v.ogg', contentType: 'audio/ogg' },
    });

    expect(getResponse).toHaveBeenCalledWith(
      'thoughts?\n\n[voice message transcript] one two three four',
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it('never reads attachments for unengaged messages or bang commands', async () => {
    setupMocks();

    // Not addressed in a require-mention channel: no reads at all.
    await drive({
      content: 'nice take everyone',
      mentions: [],
      media: { url: 'https://cdn.example/x.png', contentType: 'image/png', kind: 'image' },
    });
    expect(prepareDiscordVision).not.toHaveBeenCalled();

    // Bang command: feature handlers own the raw query and the audio ref.
    await drive({
      content: '!idea capture',
      audio: { url: 'https://cdn.example/v.ogg', contentType: 'audio/ogg' },
      media: { url: 'https://cdn.example/x.png', contentType: 'image/png', kind: 'image' },
    });
    expect(prepareDiscordVision).not.toHaveBeenCalled();
    expect(transcribeDiscordAttachment).not.toHaveBeenCalled();
  });
});
