import { describe, it, expect } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

describe('health rate-limit hygiene', () => {
  it('normalizes IPv6-mapped IPv4 to the same bucket', async () => {
    const { __testing } = await import('../src/middleware/health.js');
    expect(__testing.normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(__testing.normalizeIp('127.0.0.1')).toBe('127.0.0.1');
  });
});
