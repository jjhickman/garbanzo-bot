import type { ExecFileOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileResult = {
  stdout: string;
  stderr: string;
};

type MockChildProcess = EventEmitter & {
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

const ORIGINAL_PIPER_BIN = process.env.PIPER_BIN;
const ORIGINAL_YT_DLP_BIN = process.env.YT_DLP_BIN;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function createExecFileMock(
  handler: (file: string, args: string[], options: ExecFileOptions | undefined) => Promise<ExecFileResult>,
): { execFile: ReturnType<typeof vi.fn>; execFilePromise: ReturnType<typeof vi.fn> } {
  const execFilePromise = vi.fn(handler);
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: execFilePromise });
  return { execFile, execFilePromise };
}

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

afterEach(() => {
  restoreEnv('PIPER_BIN', ORIGINAL_PIPER_BIN);
  restoreEnv('YT_DLP_BIN', ORIGINAL_YT_DLP_BIN);
  vi.doUnmock('node:child_process');
  vi.doUnmock('child_process');
  vi.doUnmock('node:fs');
  vi.doUnmock('fs');
  vi.doUnmock('node:fs/promises');
  vi.doUnmock('fs/promises');
  vi.doUnmock('../src/features/voice.js');
  vi.unstubAllGlobals();
});

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

    const firstArg = downloadMediaMessage.mock.calls[0]?.[0] as { key?: { remoteJid?: unknown } };
    expect(firstArg.key?.remoteJid).toBe('test@g.us');
  });

  it('extracts video frames using ffprobe and ffmpeg arg arrays', async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const tmpVideo = join(tmpdir(), `garbanzo-video-${now}.mp4`);
    const tmpFrame = join(tmpdir(), `garbanzo-frame-${now}-%03d.jpg`);
    const firstFrame = tmpFrame.replace('%03d', '001');

    const { execFile, execFilePromise } = createExecFileMock(async (file) => {
      if (file === 'ffprobe') {
        return { stdout: '12.5\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    vi.doMock('node:child_process', () => ({ execFile }));

    vi.doMock('node:fs/promises', () => ({
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async (path: string) => {
        if (path === firstFrame) return Buffer.from('frame-one');
        throw new Error('frame missing');
      }),
      unlink: vi.fn(async () => undefined),
    }));

    const { prepareForVision } = await import('../src/core/vision.js');
    const frames = await prepareForVision({
      type: 'video',
      data: Buffer.from('video-bytes'),
      mimeType: 'video/mp4',
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]?.base64).toBe(Buffer.from('frame-one').toString('base64'));
    expect(execFilePromise).toHaveBeenNthCalledWith(
      1,
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmpVideo],
      { maxBuffer: 1024 * 1024 },
    );
    expect(execFilePromise).toHaveBeenNthCalledWith(
      2,
      'ffmpeg',
      ['-y', '-i', tmpVideo, '-vf', 'fps=1/4', '-frames:v', '10', '-q:v', '2', tmpFrame],
      { maxBuffer: 1024 * 1024 },
    );
  });

  it('returns an empty frame list when ffprobe is missing', async () => {
    const { execFile, execFilePromise } = createExecFileMock(async () => {
      throw Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' });
    });
    vi.doMock('node:child_process', () => ({ execFile }));
    vi.doMock('node:fs/promises', () => ({
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => Buffer.from('unused')),
      unlink: vi.fn(async () => undefined),
    }));

    const { prepareForVision } = await import('../src/core/vision.js');
    const frames = await prepareForVision({
      type: 'video',
      data: Buffer.from('video-bytes'),
      mimeType: 'video/mp4',
    });

    expect(frames).toEqual([]);
    expect(execFilePromise).toHaveBeenCalledTimes(1);
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
    process.env.PIPER_BIN = '/tmp/piper-test';
    const { execFile, execFilePromise } = createExecFileMock(async () => ({ stdout: '', stderr: '' }));
    const child = createMockChildProcess();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });

    vi.doMock('node:child_process', () => ({ execFile, spawn }));
    vi.doMock('node:fs', () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock('node:fs/promises', () => ({
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => Buffer.from('ogg-bytes')),
      unlink: vi.fn(async () => undefined),
    }));

    const { textToSpeech } = await import('../src/features/voice.js');
    const audio = await textToSpeech('hello world', 'british');

    expect(audio).toBeInstanceOf(Buffer);
    expect(audio?.toString()).toBe('ogg-bytes');
    expect(spawn).toHaveBeenCalledWith(
      '/tmp/piper-test',
      ['-m', expect.stringContaining('en_GB-cori-medium.onnx'), '-f', expect.stringMatching(/garbanzo-tts-\d+\.wav$/)],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    expect(child.stdin.end).toHaveBeenCalledWith('hello world');
    expect(execFilePromise).toHaveBeenCalledWith(
      'ffmpeg',
      [
        '-y',
        '-i',
        expect.stringMatching(/garbanzo-tts-\d+\.wav$/),
        '-c:a',
        'libopus',
        '-b:a',
        '48k',
        '-ar',
        '48000',
        '-ac',
        '1',
        expect.stringMatching(/garbanzo-tts-\d+\.ogg$/),
      ],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
    );
  });

  it('returns null when the Piper binary is missing', async () => {
    process.env.PIPER_BIN = '/tmp/missing-piper';
    const { execFile, execFilePromise } = createExecFileMock(async () => ({ stdout: '', stderr: '' }));
    const child = createMockChildProcess();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return child;
    });

    vi.doMock('node:child_process', () => ({ execFile, spawn }));
    vi.doMock('node:fs', () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock('node:fs/promises', () => ({
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => Buffer.from('unused')),
      unlink: vi.fn(async () => undefined),
    }));

    const { textToSpeech } = await import('../src/features/voice.js');
    const audio = await textToSpeech('hello world', 'british');

    expect(audio).toBeNull();
    expect(spawn).toHaveBeenCalledWith(
      '/tmp/missing-piper',
      ['-m', expect.stringContaining('en_GB-cori-medium.onnx'), '-f', expect.stringMatching(/garbanzo-tts-\d+\.wav$/)],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    expect(execFilePromise).not.toHaveBeenCalled();
  });
});

describe('Link pipeline integration (mocked)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('processes YouTube links with mocked yt-dlp + Whisper transcription', async () => {
    process.env.YT_DLP_BIN = '/tmp/yt-dlp-test';
    const { execFile, execFilePromise } = createExecFileMock(async (_file, args) => {
      if (args.includes('--print')) {
        return { stdout: 'Test Video|||125|||Test Channel\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    vi.doMock('node:child_process', () => ({ execFile }));
    vi.doMock('node:fs/promises', () => ({
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
    expect(execFilePromise).toHaveBeenCalledWith(
      '/tmp/yt-dlp-test',
      ['--print', '%(title)s|||%(duration)s|||%(channel)s', '--no-download', 'https://youtu.be/dQw4w9WgXcQ'],
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
    );
    expect(execFilePromise).toHaveBeenCalledWith(
      '/tmp/yt-dlp-test',
      [
        '-x',
        '--audio-format',
        'm4a',
        '--audio-quality',
        '0',
        '--max-filesize',
        '50M',
        '--match-filter',
        'duration < 900',
        '-o',
        expect.stringMatching(/garbanzo-yt-\d+\.m4a$/),
        'https://youtu.be/dQw4w9WgXcQ',
      ],
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
    );
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it('returns null for YouTube links when yt-dlp is missing', async () => {
    process.env.YT_DLP_BIN = '/tmp/missing-yt-dlp';
    const { execFile, execFilePromise } = createExecFileMock(async () => {
      throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' });
    });

    vi.doMock('node:child_process', () => ({ execFile }));
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn(async () => Buffer.from('unused')),
      unlink: vi.fn(async () => undefined),
      stat: vi.fn(async () => ({ size: 1024 })),
    }));

    const transcribeAudio = vi.fn(async () => 'unused transcript');
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));

    const { processUrl } = await import('../src/features/links.js');
    const out = await processUrl('https://youtu.be/dQw4w9WgXcQ');

    expect(out).toBeNull();
    expect(execFilePromise).toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
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
