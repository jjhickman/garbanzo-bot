import { describe, expect, it } from 'vitest';

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
});
