import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Media pipeline integration (mocked)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('extracts direct image media with Baileys download mock', async () => {
    const downloadMediaMessage = vi.fn(async () => Buffer.from('image-bytes'));
    const getContentType = vi.fn((content: Record<string, unknown>) =>
      content.imageMessage ? 'imageMessage' : null,
    );
    const normalizeMessageContent = vi.fn((content: unknown) => content);

    vi.doMock('@whiskeysockets/baileys', () => ({
      downloadMediaMessage,
      getContentType,
      normalizeMessageContent,
    }));

    const { extractMedia } = await import('../src/platforms/whatsapp/media.js');
    const { prepareForVision } = await import('../src/core/vision.js');

    const msg = {
      key: { id: 'm1', remoteJid: 'test@g.us' },
      message: {
        imageMessage: {
          mimetype: 'image/png',
          caption: 'Look at this',
        },
      },
    };

    const media = await extractMedia(msg as never);
    expect(media).not.toBeNull();
    expect(media?.type).toBe('image');
    expect(media?.mimeType).toBe('image/png');
    expect(media?.caption).toBe('Look at this');
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);

    if (!media) throw new Error('expected media');
    const vision = await prepareForVision(media);
    expect(vision).toHaveLength(1);
    expect(vision[0]?.mediaType).toBe('image/png');
    expect(vision[0]?.description).toBe('Look at this');
  });

  it('extracts quoted image media from contextInfo', async () => {
    const downloadMediaMessage = vi.fn(async () => Buffer.from('quoted-image'));
    const normalizeMessageContent = vi.fn((content: unknown) => content);
    const getContentType = vi.fn((content: Record<string, unknown>) => {
      if (content.extendedTextMessage) return 'extendedTextMessage';
      if (content.imageMessage) return 'imageMessage';
      return null;
    });

    vi.doMock('@whiskeysockets/baileys', () => ({
      downloadMediaMessage,
      getContentType,
      normalizeMessageContent,
    }));

    const { extractMedia } = await import('../src/platforms/whatsapp/media.js');

    const msg = {
      key: { id: 'm2', remoteJid: 'test@g.us' },
      message: {
        extendedTextMessage: {
          text: 'what is this?',
          contextInfo: {
            stanzaId: 'quoted-1',
            quotedMessage: {
              imageMessage: {
                mimetype: 'image/jpeg',
                caption: 'quoted caption',
              },
            },
          },
        },
      },
    };

    const media = await extractMedia(msg as never);
    expect(media).not.toBeNull();
    expect(media?.type).toBe('image');
    expect(media?.caption).toBe('quoted caption');
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
  });
});

describe('Voice pipeline integration (mocked)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('transcribes audio via mocked Whisper API fetch', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: '  hello from whisper  ' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { transcribeAudio } = await import('../src/features/voice.js');
    const result = await transcribeAudio(Buffer.from('audio-bytes'), 'audio/ogg');

    expect(result).toBe('hello from whisper');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('generates TTS audio via mocked Piper and ffmpeg subprocesses', async () => {
    const exec = vi.fn((command: string, optionsOrCb: unknown, cbArg?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      const cb = typeof optionsOrCb === 'function'
        ? optionsOrCb as (err: Error | null, result: { stdout: string; stderr: string }) => void
        : cbArg;
      cb?.(null, { stdout: '', stderr: '' });
      return {};
    });

    vi.doMock('child_process', () => ({ exec }));
    vi.doMock('fs', () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock('fs/promises', () => ({
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => Buffer.from('ogg-bytes')),
      unlink: vi.fn(async () => undefined),
    }));

    const { textToSpeech } = await import('../src/features/voice.js');
    const audio = await textToSpeech('hello world', 'british');

    expect(audio).toBeInstanceOf(Buffer);
    expect(audio?.toString()).toBe('ogg-bytes');
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('Link pipeline integration (mocked)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('processes YouTube links with mocked yt-dlp + Whisper transcription', async () => {
    const exec = vi.fn((command: string, optionsOrCb: unknown, cbArg?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      const cb = typeof optionsOrCb === 'function'
        ? optionsOrCb as (err: Error | null, result: { stdout: string; stderr: string }) => void
        : cbArg;
      if (command.includes('--print')) {
        cb?.(null, { stdout: 'Test Video|||125|||Test Channel\n', stderr: '' });
      } else {
        cb?.(null, { stdout: '', stderr: '' });
      }
      return {};
    });

    vi.doMock('child_process', () => ({ exec }));
    vi.doMock('fs/promises', () => ({
      readFile: vi.fn(async () => Buffer.from('m4a-bytes')),
      unlink: vi.fn(async () => undefined),
      stat: vi.fn(async () => ({ size: 1024 })),
    }));

    const transcribeAudio = vi.fn(async () => 'transcribed youtube audio');
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));

    const { processUrl } = await import('../src/features/links.js');
    const out = await processUrl('https://youtu.be/dQw4w9WgXcQ');

    expect(out).toContain('YouTube: "Test Video" by Test Channel (2:05)');
    expect(out).toContain('Transcript: transcribed youtube audio');
    expect(exec).toHaveBeenCalled();
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it('processes general web links with mocked fetch content extraction', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html><head><title>x</title><style>.x{}</style></head><body><h1>Hello</h1><p>This is a long enough body of text to pass minimum threshold and be included for context extraction.</p><script>alert(1)</script></body></html>',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { processUrl } = await import('../src/features/links.js');
    const out = await processUrl('https://example.com/article');

    expect(out).toContain('[Link content from example.com]');
    expect(out).toContain('Hello This is a long enough body of text');
    expect(out).not.toContain('alert(1)');
  });
});
