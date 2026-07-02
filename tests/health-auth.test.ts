process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import type { IncomingMessage } from 'http';
import { describe, expect, it } from 'vitest';

function request(url: string, authorization?: string): IncomingMessage {
  return {
    url,
    headers: authorization === undefined ? {} : { authorization },
  } as IncomingMessage;
}

describe('health/admin auth token extraction', () => {
  it('accepts Bearer auth and preserves query-token auth', async () => {
    const { __testing } = await import('../src/middleware/health.js');

    expect(__testing.requestHasValidToken(request('/metrics?token=T'), 'T')).toBe(true);
    expect(__testing.requestHasValidToken(request('/metrics', 'Bearer T'), 'T')).toBe(true);
    expect(__testing.requestHasValidToken(request('/admin', 'Bearer WRONG'), 'T')).toBe(false);
    expect(__testing.requestHasValidToken(request('/admin.json'), 'T')).toBe(false);
  });
});
