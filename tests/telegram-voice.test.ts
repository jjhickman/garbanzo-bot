import { describe, expect, it, vi } from 'vitest';

import { downloadTelegramVoice } from '../src/platforms/telegram/telegram-voice.js';

const TOKEN = 'super-secret-bot-token-123';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function bytesResponse(bytes: Uint8Array, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

describe('downloadTelegramVoice', () => {
  it('downloads bytes via getFile + the file endpoint and never returns a URL', async () => {
    const calls: string[] = [];
    const payload = new Uint8Array([1, 2, 3, 4]);
    const fetchFn: typeof fetch = async (url) => {
      const urlString = String(url);
      calls.push(urlString);
      if (urlString.includes('/getFile')) {
        return jsonResponse({ ok: true, result: { file_path: 'voice/file_1.oga' } });
      }
      return bytesResponse(payload);
    };

    const result = await downloadTelegramVoice(TOKEN, 'file-id-1', { fetchFn });

    expect(result).toBeInstanceOf(Buffer);
    expect(Array.from(result ?? [])).toEqual([1, 2, 3, 4]);
    // Sanity: the token-bearing file URL WAS constructed and fetched...
    expect(calls.some((url) => url.includes(TOKEN))).toBe(true);
    // ...but the function's return value is a Buffer, never a string/URL.
    expect(typeof result).not.toBe('string');
  });

  it('returns null when getFile fails, without throwing', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({}, false);

    await expect(downloadTelegramVoice(TOKEN, 'file-id-1', { fetchFn })).resolves.toBeNull();
  });

  it('returns null when getFile reports ok:false', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ ok: false });

    await expect(downloadTelegramVoice(TOKEN, 'file-id-1', { fetchFn })).resolves.toBeNull();
  });

  it('returns null when the file download itself fails', async () => {
    const fetchFn: typeof fetch = async (url) => {
      if (String(url).includes('/getFile')) {
        return jsonResponse({ ok: true, result: { file_path: 'voice/file_1.oga' } });
      }
      return bytesResponse(new Uint8Array(), false);
    };

    await expect(downloadTelegramVoice(TOKEN, 'file-id-1', { fetchFn })).resolves.toBeNull();
  });

  it('CREDENTIAL RULE: never logs the token-bearing file URL, even when fetch throws mid-download', async () => {
    const loggerWarn = vi.fn();
    vi.resetModules();
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { warn: loggerWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
    }));

    const { downloadTelegramVoice: downloadWithMockedLogger } = await import('../src/platforms/telegram/telegram-voice.js');

    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/voice/file_1.oga`;
    const fetchFn: typeof fetch = async (url) => {
      if (String(url).includes('/getFile')) {
        return jsonResponse({ ok: true, result: { file_path: 'voice/file_1.oga' } });
      }
      // Simulate a fetch failure whose error message happens to embed the URL
      // (worst case for the redaction defense-in-depth).
      throw new Error(`fetch failed for ${fileUrl}`);
    };

    const result = await downloadWithMockedLogger(TOKEN, 'file-id-1', { fetchFn });

    expect(result).toBeNull();
    expect(loggerWarn).toHaveBeenCalled();
    for (const call of loggerWarn.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(TOKEN);
    }

    vi.doUnmock('../src/middleware/logger.js');
    vi.resetModules();
  });

  it('CREDENTIAL RULE: success-path logging (none expected) never includes the token or file URL', async () => {
    const loggerWarn = vi.fn();
    const loggerInfo = vi.fn();
    vi.resetModules();
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { warn: loggerWarn, error: vi.fn(), info: loggerInfo, debug: vi.fn(), fatal: vi.fn() },
    }));

    const { downloadTelegramVoice: downloadWithMockedLogger } = await import('../src/platforms/telegram/telegram-voice.js');

    const payload = new Uint8Array([9, 9, 9]);
    const fetchFn: typeof fetch = async (url) => {
      if (String(url).includes('/getFile')) {
        return jsonResponse({ ok: true, result: { file_path: 'voice/file_1.oga' } });
      }
      return bytesResponse(payload);
    };

    await downloadWithMockedLogger(TOKEN, 'file-id-1', { fetchFn });

    for (const call of [...loggerWarn.mock.calls, ...loggerInfo.mock.calls]) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(TOKEN);
    }

    vi.doUnmock('../src/middleware/logger.js');
    vi.resetModules();
  });
});
