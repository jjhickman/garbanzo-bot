import { describe, expect, it } from 'vitest';

import { resolveOwnerDmChannelId } from '../src/platforms/discord/discord-owner.js';

function makeResponse(options: { ok: boolean; status?: number; json?: unknown; text?: string }): Response {
  return {
    ok: options.ok,
    status: options.status ?? (options.ok ? 200 : 500),
    json: async () => options.json,
    text: async () => options.text ?? '',
  } as unknown as Response;
}

describe('resolveOwnerDmChannelId', () => {
  it('creates an owner DM channel and returns its id', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return makeResponse({ ok: true, json: { id: 'dm123' } });
    };

    const channelId = await resolveOwnerDmChannelId('tok123', 'owner1', { fetchFn });

    expect(channelId).toBe('dm123');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://discord.com/api/v10/users/@me/channels');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bot tok123',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ recipient_id: 'owner1' });
  });

  it('returns null for non-ok Discord responses', async () => {
    const fetchFn: typeof fetch = async () => makeResponse({ ok: false, status: 500, text: 'nope' });

    await expect(resolveOwnerDmChannelId('tok123', 'owner1', { fetchFn })).resolves.toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchFn: typeof fetch = async () => {
      throw new Error('network failed');
    };

    await expect(resolveOwnerDmChannelId('tok123', 'owner1', { fetchFn })).resolves.toBeNull();
  });
});
