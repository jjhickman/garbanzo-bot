process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VisionImage } from '../src/core/vision.js';
import type { ReadableAttachment } from '../src/core/attachment-reading.js';

// ── Core: platform-agnostic attachment reader ───────────────────────

describe('core attachment reading', () => {
  const prepareForVision = vi.fn<(media: unknown) => Promise<VisionImage[]>>();
  const transcribeAudio = vi.fn<(buffer: Buffer, mime?: string) => Promise<string | null>>();
  let savedWhisperUrl: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    prepareForVision.mockReset();
    transcribeAudio.mockReset();
    savedWhisperUrl = process.env.WHISPER_URL;

    vi.doMock('../src/core/vision.js', () => ({ prepareForVision }));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));
  });

  afterEach(() => {
    if (savedWhisperUrl === undefined) delete process.env.WHISPER_URL;
    else process.env.WHISPER_URL = savedWhisperUrl;
    vi.doUnmock('../src/core/vision.js');
    vi.doUnmock('../src/features/voice.js');
  });

  async function importCore() {
    return import('../src/core/attachment-reading.js');
  }

  function attachment(overrides: Partial<ReadableAttachment> = {}): ReadableAttachment {
    return {
      kind: 'image',
      contentType: 'image/png',
      bytes: async () => Buffer.from('bytes'),
      ...overrides,
    };
  }

  it('prepares the first visual attachment for vision, defaulting caption to the query', async () => {
    prepareForVision.mockResolvedValue([{ base64: 'aW1n', mediaType: 'image/png' }]);
    const { readAttachments } = await importCore();

    const result = await readAttachments([attachment()], 'what is this?');

    expect(result.visionImages).toEqual([{ base64: 'aW1n', mediaType: 'image/png' }]);
    expect(result.enrichedQuery).toBe('what is this?');
    expect(prepareForVision).toHaveBeenCalledWith({
      type: 'image',
      data: Buffer.from('bytes'),
      mimeType: 'image/png',
      caption: 'what is this?',
    });
  });

  it('prefers the attachment caption over the query and maps gif/video/sticker kinds', async () => {
    prepareForVision.mockResolvedValue([{ base64: 'eA==', mediaType: 'image/gif' }]);
    const { readAttachments } = await importCore();

    await readAttachments([attachment({ kind: 'gif', contentType: 'image/gif', caption: 'a cat' })], 'q');
    expect(prepareForVision).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'gif', caption: 'a cat' }));

    await readAttachments([attachment({ kind: 'video', contentType: 'video/mp4' })], '');
    expect(prepareForVision).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'video', caption: undefined }));

    await readAttachments([attachment({ kind: 'sticker', contentType: 'image/webp' })], '');
    expect(prepareForVision).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'sticker' }));
  });

  it('reads only the first visual attachment; later visuals become context lines', async () => {
    prepareForVision.mockResolvedValue([{ base64: 'aW1n', mediaType: 'image/png' }]);
    const { readAttachments } = await importCore();

    const result = await readAttachments([
      attachment({ fileName: 'a.png' }),
      attachment({ fileName: 'b.png' }),
    ], 'q');

    expect(prepareForVision).toHaveBeenCalledTimes(1);
    expect(result.enrichedQuery).toBe('q\n\n[attachment: b.png (image/png)]');
  });

  it('degrades failed vision to a context line (null bytes, throw, empty result)', async () => {
    const { readAttachments } = await importCore();

    let result = await readAttachments([attachment({ fileName: 'x.png', bytes: async () => null })], 'q');
    expect(result.visionImages).toBeUndefined();
    expect(result.enrichedQuery).toBe('q\n\n[attachment: x.png (image/png)]');

    result = await readAttachments([attachment({ bytes: async () => { throw new Error('cdn down'); } })], 'q');
    expect(result.enrichedQuery).toBe('q\n\n[attachment: file (image/png)]');

    prepareForVision.mockResolvedValue([]);
    result = await readAttachments([attachment()], 'q');
    expect(result.enrichedQuery).toBe('q\n\n[attachment: file (image/png)]');
  });

  it('describes documents with fileName and contentType, never downloading them', async () => {
    const bytes = vi.fn(async () => Buffer.from('pdf'));
    const { readAttachments } = await importCore();

    const result = await readAttachments(
      [attachment({ kind: 'document', contentType: 'application/pdf', fileName: 'tabs.pdf', bytes })],
      'can you check this?',
    );

    expect(result.visionImages).toBeUndefined();
    expect(result.enrichedQuery).toBe('can you check this?\n\n[attachment: tabs.pdf (application/pdf)]');
    expect(bytes).not.toHaveBeenCalled();
  });

  it('skips transcription entirely without an explicit WHISPER_URL', async () => {
    delete process.env.WHISPER_URL;
    const bytes = vi.fn(async () => Buffer.from('voice'));
    const { readAttachments } = await importCore();

    const result = await readAttachments(
      [attachment({ kind: 'audio', contentType: 'audio/ogg', bytes })],
      'thoughts?',
    );

    expect(bytes).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(result.enrichedQuery).toBe('thoughts?\n\n[attachment: voice message (audio/ogg)]');
  });

  it('appends the trimmed transcript for audio attachments', async () => {
    process.env.WHISPER_URL = 'http://whisper.test:8090';
    transcribeAudio.mockResolvedValue('  count us in  ');
    const { readAttachments } = await importCore();

    const result = await readAttachments(
      [attachment({ kind: 'audio', contentType: 'audio/ogg', bytes: async () => Buffer.from('voice') })],
      'thoughts?',
    );

    expect(transcribeAudio).toHaveBeenCalledWith(Buffer.from('voice'), 'audio/ogg');
    expect(result.enrichedQuery).toBe('thoughts?\n\n[voice message transcript] count us in');
  });

  it('degrades failed transcription to a context line and never throws', async () => {
    process.env.WHISPER_URL = 'http://whisper.test:8090';
    const { readAttachments } = await importCore();
    const audio = { kind: 'audio' as const, contentType: 'audio/ogg' };

    transcribeAudio.mockResolvedValue('   ');
    let result = await readAttachments([attachment({ ...audio, bytes: async () => Buffer.from('v') })], '');
    expect(result.enrichedQuery).toBe('[attachment: voice message (audio/ogg)]');

    transcribeAudio.mockRejectedValue(new Error('whisper down'));
    result = await readAttachments([attachment({ ...audio, bytes: async () => Buffer.from('v') })], '');
    expect(result.enrichedQuery).toBe('[attachment: voice message (audio/ogg)]');

    result = await readAttachments([attachment({ ...audio, bytes: async () => null })], '');
    expect(result.enrichedQuery).toBe('[attachment: voice message (audio/ogg)]');
  });

  it('returns the query untouched for no attachments', async () => {
    const { readAttachments } = await importCore();
    const result = await readAttachments([], 'plain question');
    expect(result).toEqual({ visionImages: undefined, enrichedQuery: 'plain question' });
  });

  it('pickAttachments prefers direct attachments and falls back to quoted', async () => {
    const { pickAttachments } = await importCore();
    const direct = [attachment({ fileName: 'direct.png' })];
    const quoted = [attachment({ fileName: 'quoted.png' })];

    expect(pickAttachments(direct, quoted)).toBe(direct);
    expect(pickAttachments([], quoted)).toBe(quoted);
    expect(pickAttachments([], [])).toEqual([]);
  });
});
