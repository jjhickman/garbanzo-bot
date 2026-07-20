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
import type { DiscordMessageAttachments } from '../src/platforms/discord/attachment-classification.js';

type FeaturePredicate = (chatId: string, feature: string) => boolean;
type MockGetResponse = (
  query: string,
  ctx: MessageContext,
  isFeatureEnabled: FeaturePredicate,
  visionImages?: VisionImage[],
) => Promise<string | null>;

// ── Unit: Discord collector ─────────────────────────────────────────

describe('discord attachment collector', () => {
  const fetchBoundedBuffer = vi.fn<(url: string, options: unknown) => Promise<Buffer | null>>();

  beforeEach(() => {
    vi.resetModules();
    fetchBoundedBuffer.mockReset();
    vi.doMock('../src/utils/bounded-fetch.js', () => ({ fetchBoundedBuffer }));
  });

  afterEach(() => {
    vi.doUnmock('../src/utils/bounded-fetch.js');
  });

  async function importCollector() {
    return import('../src/platforms/discord/attachment-reading.js');
  }

  it('maps direct media and audio into readable attachments with bounded lazy bytes', async () => {
    fetchBoundedBuffer.mockResolvedValue(Buffer.from('bytes'));
    const { collectDiscordDirectAttachments } = await importCollector();

    const attachments = collectDiscordDirectAttachments({
      media: { url: 'https://cdn.example/x.png', contentType: 'image/png', fileName: 'x.png', kind: 'image' },
      audio: { url: 'https://cdn.example/v.ogg', contentType: 'audio/ogg' },
    });

    expect(attachments.map((a) => a.kind)).toEqual(['image', 'audio']);
    expect(fetchBoundedBuffer).not.toHaveBeenCalled();

    await attachments[0].bytes();
    expect(fetchBoundedBuffer).toHaveBeenCalledWith(
      'https://cdn.example/x.png',
      expect.objectContaining({ maxBytes: 8 * 1024 * 1024 }),
    );
  });

  it('maps gif/sticker/video/document kinds from contentType', async () => {
    const { collectDiscordDirectAttachments } = await importCollector();

    const kinds = (media: { url: string; contentType: string; kind: 'image' | 'video' | 'document' | 'sticker' }) =>
      collectDiscordDirectAttachments({ media })[0]?.kind;

    expect(kinds({ url: 'u', contentType: 'image/gif', kind: 'image' })).toBe('gif');
    expect(kinds({ url: 'u', contentType: 'video/mp4', kind: 'video' })).toBe('video');
    expect(kinds({ url: 'u', contentType: 'application/pdf', kind: 'document' })).toBe('document');
    expect(kinds({ url: 'u', contentType: 'image/webp', kind: 'sticker' })).toBe('sticker');
  });

  it('maps a REST-fetched referenced message classification into readable attachments', async () => {
    fetchBoundedBuffer.mockResolvedValue(Buffer.from('quoted-bytes'));
    const { collectDiscordReferencedAttachments } = await importCollector();

    const attachments = collectDiscordReferencedAttachments({
      audio: { url: 'https://cdn.example/q.ogg', contentType: 'audio/ogg' },
      media: { url: 'https://cdn.example/q.png', contentType: 'image/png', fileName: 'q.png', kind: 'image' },
    });

    expect(attachments.map((a) => a.kind)).toEqual(['image', 'audio']);
    expect(attachments[0].fileName).toBe('q.png');
    expect(fetchBoundedBuffer).not.toHaveBeenCalled();

    await attachments[1].bytes();
    expect(fetchBoundedBuffer).toHaveBeenCalledWith(
      'https://cdn.example/q.ogg',
      expect.objectContaining({ maxBytes: 8 * 1024 * 1024 }),
    );
  });

  it('collects nothing for a plain message', async () => {
    const { collectDiscordDirectAttachments } = await importCollector();
    expect(collectDiscordDirectAttachments({})).toEqual([]);
  });
});

// ── Unit: gateway threads only the referenced message id ────────────

describe('discord gateway referenced-message id threading', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('threads reference.messageId from a discord.js-shaped message', async () => {
    const { mapMessageToPayload } = await import('../src/platforms/discord/gateway-client.js');

    // discord.js v14 Message exposes `reference` only — never a synchronous
    // referencedMessage with attachments.
    const payload = mapMessageToPayload({
      id: 'msg-1',
      channelId: 'chan-1',
      content: 'what do you think?',
      author: { id: 'author-1', bot: false },
      attachments: [],
      reference: { channelId: 'chan-1', guildId: 'guild-1', messageId: 'ref-1' },
    });

    expect(payload.referenced_message).toEqual({ id: 'ref-1' });
  });

  it('keeps raw referenced_message id/content but never fabricates attachment refs', async () => {
    const { mapMessageToPayload } = await import('../src/platforms/discord/gateway-client.js');

    const payload = mapMessageToPayload({
      id: 'msg-1',
      channelId: 'chan-1',
      content: 'listen to this',
      author: { id: 'author-1', bot: false },
      attachments: [],
      referenced_message: {
        id: 'ref-2',
        content: 'the original',
        attachments: [{ url: 'https://cdn.example/v.ogg', content_type: 'audio/ogg', filename: 'v.ogg' }],
      },
    });

    // Attachments of the replied-to message are resolved lazily via REST
    // after the engagement decision — the payload carries only id/content.
    expect(payload.referenced_message).toEqual({ id: 'ref-2', content: 'the original' });
  });

  it('threads no referenced_message for a non-reply', async () => {
    const { mapMessageToPayload } = await import('../src/platforms/discord/gateway-client.js');

    const payload = mapMessageToPayload({
      id: 'msg-1',
      channelId: 'chan-1',
      content: 'plain message',
      author: { id: 'author-1', bot: false },
      attachments: [],
    });

    expect(payload.referenced_message).toBeUndefined();
  });
});

// ── Wiring: processor reads attachments into the group dispatch ─────

describe('discord processor attachment wiring', () => {
  const fetchBoundedBuffer = vi.fn<(url: string, options: unknown) => Promise<Buffer | null>>();
  const prepareForVision = vi.fn<(media: unknown) => Promise<VisionImage[]>>();
  const transcribeAudio = vi.fn<(buffer: Buffer, mime?: string) => Promise<string | null>>();
  const fetchMessageAttachments = vi.fn<(channelId: string, messageId: string) => Promise<DiscordMessageAttachments | null>>();
  let savedWhisperUrl: string | undefined;

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
    vi.doMock('../src/utils/bounded-fetch.js', () => ({ fetchBoundedBuffer }));
    vi.doMock('../src/core/vision.js', () => ({ prepareForVision }));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));

    return { getResponse };
  }

  beforeEach(() => {
    vi.resetModules();
    fetchBoundedBuffer.mockReset();
    prepareForVision.mockReset();
    transcribeAudio.mockReset();
    fetchMessageAttachments.mockReset();
    fetchMessageAttachments.mockResolvedValue(null);
    savedWhisperUrl = process.env.WHISPER_URL;
    process.env.WHISPER_URL = 'http://whisper.test:8090';
  });

  afterEach(() => {
    if (savedWhisperUrl === undefined) delete process.env.WHISPER_URL;
    else process.env.WHISPER_URL = savedWhisperUrl;
    vi.doUnmock('../src/platforms/discord/discord-config.js');
    vi.doUnmock('../src/core/response-router.js');
    vi.doUnmock('../src/utils/bounded-fetch.js');
    vi.doUnmock('../src/core/vision.js');
    vi.doUnmock('../src/features/voice.js');
  });

  async function drive(event: Record<string, unknown>): Promise<DiscordDemoOutboxEntry[]> {
    const adapterModule = await import('../src/platforms/discord/adapter.js');
    const processorModule = await import('../src/platforms/discord/processor.js');
    const outbox: DiscordDemoOutboxEntry[] = [];
    // Demo adapter surface + a controllable referenced-message fetch: the
    // processor must only ever reach quoted attachments through this method.
    const messenger = { ...adapterModule.createDiscordDemoAdapter(outbox), fetchMessageAttachments };
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
    fetchBoundedBuffer.mockResolvedValue(Buffer.from('img-bytes'));
    prepareForVision.mockResolvedValue(images);

    await drive({
      content: '<@bot-user> what do you think of this?',
      media: { url: 'https://cdn.example/x.png', contentType: 'image/png', fileName: 'x.png', kind: 'image' },
    });

    expect(prepareForVision).toHaveBeenCalledWith({
      type: 'image',
      data: Buffer.from('img-bytes'),
      mimeType: 'image/png',
      caption: 'what do you think of this?',
    });
    expect(getResponse).toHaveBeenCalledWith(
      'what do you think of this?',
      expect.anything(),
      expect.anything(),
      images,
    );
  });

  it('appends a context line when the attachment cannot be read', async () => {
    const { getResponse } = setupMocks();

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
    fetchBoundedBuffer.mockResolvedValue(Buffer.from('voice-bytes'));
    transcribeAudio.mockResolvedValue('one two three four');

    await drive({
      content: '<@bot-user> thoughts?',
      audio: { url: 'https://cdn.example/v.ogg', contentType: 'audio/ogg' },
    });

    expect(transcribeAudio).toHaveBeenCalledWith(Buffer.from('voice-bytes'), 'audio/ogg');
    expect(getResponse).toHaveBeenCalledWith(
      'thoughts?\n\n[voice message transcript] one two three four',
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it('lazily fetches and reads the REPLIED-TO image when the engaging mention has none', async () => {
    const { getResponse } = setupMocks();
    const images: VisionImage[] = [{ base64: 'cQ==', mediaType: 'image/png' }];
    fetchBoundedBuffer.mockResolvedValue(Buffer.from('quoted-bytes'));
    prepareForVision.mockResolvedValue(images);
    fetchMessageAttachments.mockResolvedValue({
      media: { url: 'https://cdn.example/q.png', contentType: 'image/png', fileName: 'q.png', kind: 'image' },
    });

    await drive({
      content: '<@bot-user> what is in this picture?',
      referenced_message: { id: 'ref-1' },
    });

    expect(fetchMessageAttachments).toHaveBeenCalledWith('chan-1', 'ref-1');
    expect(fetchBoundedBuffer).toHaveBeenCalledWith('https://cdn.example/q.png', expect.anything());
    expect(getResponse).toHaveBeenCalledWith(
      'what is in this picture?',
      expect.anything(),
      expect.anything(),
      images,
    );
  });

  it('transcribes the REPLIED-TO voice message', async () => {
    const { getResponse } = setupMocks();
    fetchBoundedBuffer.mockResolvedValue(Buffer.from('quoted-voice'));
    transcribeAudio.mockResolvedValue('meet at seven');
    fetchMessageAttachments.mockResolvedValue({
      audio: { url: 'https://cdn.example/q.ogg', contentType: 'audio/ogg' },
    });

    await drive({
      content: '<@bot-user> what did they say?',
      referenced_message: { id: 'ref-1' },
    });

    expect(fetchMessageAttachments).toHaveBeenCalledWith('chan-1', 'ref-1');
    expect(getResponse).toHaveBeenCalledWith(
      'what did they say?\n\n[voice message transcript] meet at seven',
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it('adds a context line for a REPLIED-TO document', async () => {
    const { getResponse } = setupMocks();
    fetchMessageAttachments.mockResolvedValue({
      media: { url: 'https://cdn.example/q.pdf', contentType: 'application/pdf', fileName: 'setlist.pdf', kind: 'document' },
    });

    await drive({
      content: '<@bot-user> summarize that file',
      referenced_message: { id: 'ref-1' },
    });

    expect(getResponse).toHaveBeenCalledWith(
      'summarize that file\n\n[attachment: setlist.pdf (application/pdf)]',
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it('still answers with the plain query when the referenced fetch yields nothing', async () => {
    const { getResponse } = setupMocks();
    fetchMessageAttachments.mockResolvedValue(null);

    await drive({
      content: '<@bot-user> what about that one?',
      referenced_message: { id: 'ref-gone' },
    });

    expect(fetchMessageAttachments).toHaveBeenCalledWith('chan-1', 'ref-gone');
    expect(fetchBoundedBuffer).not.toHaveBeenCalled();
    expect(getResponse).toHaveBeenCalledWith(
      'what about that one?',
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it('never fetches the referenced message when the engaging message has its own attachment', async () => {
    setupMocks();
    fetchBoundedBuffer.mockResolvedValue(Buffer.from('own-bytes'));
    prepareForVision.mockResolvedValue([{ base64: 'bw==', mediaType: 'image/png' }]);

    await drive({
      content: '<@bot-user> compare these',
      media: { url: 'https://cdn.example/own.png', contentType: 'image/png', kind: 'image' },
      referenced_message: { id: 'ref-1' },
    });

    expect(fetchMessageAttachments).not.toHaveBeenCalled();
    expect(fetchBoundedBuffer).toHaveBeenCalledTimes(1);
    expect(fetchBoundedBuffer).toHaveBeenCalledWith('https://cdn.example/own.png', expect.anything());
  });

  it('degrades a failed fetch to a context line instead of dropping the reply', async () => {
    const { getResponse } = setupMocks();
    fetchBoundedBuffer.mockResolvedValue(null);

    await drive({
      content: '<@bot-user> can you see this?',
      media: { url: 'https://cdn.example/x.png', contentType: 'image/png', fileName: 'x.png', kind: 'image' },
    });

    expect(getResponse).toHaveBeenCalledWith(
      'can you see this?\n\n[attachment: x.png (image/png)]',
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it('never reads or fetches attachments for unengaged messages or bang commands', async () => {
    setupMocks();

    // Not addressed in a require-mention channel: no reads, no REST fetch.
    await drive({
      content: 'nice take everyone',
      mentions: [],
      media: { url: 'https://cdn.example/x.png', contentType: 'image/png', kind: 'image' },
      referenced_message: { id: 'ref-1' },
    });
    expect(fetchBoundedBuffer).not.toHaveBeenCalled();
    expect(fetchMessageAttachments).not.toHaveBeenCalled();

    // Bang command: feature handlers own the raw query and the audio ref.
    await drive({
      content: '!idea capture',
      audio: { url: 'https://cdn.example/v.ogg', contentType: 'audio/ogg' },
      media: { url: 'https://cdn.example/x.png', contentType: 'image/png', kind: 'image' },
      referenced_message: { id: 'ref-1' },
    });
    expect(fetchBoundedBuffer).not.toHaveBeenCalled();
    expect(fetchMessageAttachments).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
  });
});
