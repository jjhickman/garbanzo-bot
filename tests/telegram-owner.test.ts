import { describe, expect, it, vi } from 'vitest';

import { resolveOwnerChatId } from '../src/platforms/telegram/telegram-owner.js';

function makeResponse(options: { ok: boolean; status?: number; json?: unknown; text?: string }): Response {
  return {
    ok: options.ok,
    status: options.status ?? (options.ok ? 200 : 500),
    json: async () => options.json,
    text: async () => options.text ?? '',
  } as unknown as Response;
}

describe('resolveOwnerChatId', () => {
  it('resolves and returns the owner chat id on success', async () => {
    const calls: { url: string }[] = [];
    const fetchFn: typeof fetch = async (url) => {
      calls.push({ url: String(url) });
      return makeResponse({ ok: true, json: { ok: true, result: { id: 987654321 } } });
    };

    const chatId = await resolveOwnerChatId('tok123', '987654321', { fetchFn });

    expect(chatId).toBe('987654321');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.telegram.org/bottok123/getChat?chat_id=987654321');
  });

  it('returns null for a non-ok HTTP response', async () => {
    const fetchFn: typeof fetch = async () => makeResponse({ ok: false, status: 500, text: 'nope' });

    await expect(resolveOwnerChatId('tok123', 'owner1', { fetchFn })).resolves.toBeNull();
  });

  it('returns null when Telegram reports ok:false', async () => {
    const fetchFn: typeof fetch = async () => makeResponse({
      ok: true,
      json: { ok: false, error_code: 400, description: 'chat not found' },
    });

    await expect(resolveOwnerChatId('tok123', 'owner1', { fetchFn })).resolves.toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchFn: typeof fetch = async () => {
      throw new Error('network failed');
    };

    await expect(resolveOwnerChatId('tok123', 'owner1', { fetchFn })).resolves.toBeNull();
  });

  it('F9 (T2 review): never logs the bot token, even when the non-ok response body embeds it', async () => {
    const loggerWarn = vi.fn();
    vi.resetModules();
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { warn: loggerWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
    }));

    const { resolveOwnerChatId: resolveWithMockedLogger } = await import('../src/platforms/telegram/telegram-owner.js');

    const token = 'super-secret-owner-token';
    const fetchFn: typeof fetch = async (url) => makeResponse({
      ok: false,
      status: 500,
      text: `upstream failed for ${String(url)}`,
    });

    const result = await resolveWithMockedLogger(token, 'owner1', { fetchFn });

    expect(result).toBeNull();
    expect(loggerWarn).toHaveBeenCalled();
    for (const call of loggerWarn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(token);
    }

    vi.doUnmock('../src/middleware/logger.js');
    vi.resetModules();
  });

  it('F9 (T2 review): never logs the bot token when fetch throws an error embedding it', async () => {
    const loggerWarn = vi.fn();
    vi.resetModules();
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { warn: loggerWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
    }));

    const { resolveOwnerChatId: resolveWithMockedLogger } = await import('../src/platforms/telegram/telegram-owner.js');

    const token = 'super-secret-owner-token';
    const fetchFn: typeof fetch = async () => {
      throw new Error(`network failed for https://api.telegram.org/bot${token}/getChat`);
    };

    const result = await resolveWithMockedLogger(token, 'owner1', { fetchFn });

    expect(result).toBeNull();
    expect(loggerWarn).toHaveBeenCalled();
    for (const call of loggerWarn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(token);
    }

    vi.doUnmock('../src/middleware/logger.js');
    vi.resetModules();
  });
});
