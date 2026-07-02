process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('instrumentation lifetime counters', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('counts rate-limit rejections when the user limit trips', async () => {
    vi.doMock('../src/utils/config.js', () => ({
      config: { OWNER_JID: 'owner@s.whatsapp.net', LOG_LEVEL: 'silent' },
    }));

    const stats = await import('../src/middleware/stats.js');
    const rateLimit = await import('../src/middleware/rate-limit.js');
    const before = stats.getLifetimeCounters().rateLimitedTotal;

    for (let i = 0; i < 10; i++) {
      rateLimit.recordResponse('sender@s.whatsapp.net', `group-${i}@g.us`);
    }

    expect(rateLimit.checkRateLimit('sender@s.whatsapp.net', 'new-group@g.us')).toContain('Easy there');
    expect(stats.getLifetimeCounters().rateLimitedTotal).toBe(before + 1);
  });

  it('counts tool-call ok and error outcomes from shared query-tool execution', async () => {
    const searchMemory = vi
      .fn<() => Promise<Array<{ fact: string; category: string }>>>()
      .mockResolvedValueOnce([{ fact: 'Public transit is preferred', category: 'preference' }])
      .mockRejectedValueOnce(new Error('db down'));

    vi.doMock('../src/utils/config.js', () => ({
      config: { AI_TOOL_CALLING: true, LOG_LEVEL: 'silent' },
    }));
    vi.doMock('../src/utils/db.js', () => ({
      searchMemory,
    }));

    const stats = await import('../src/middleware/stats.js');
    const { getEnabledTools } = await import('../src/ai/tools.js');
    const tool = getEnabledTools().find((candidate) => candidate.name === 'search_community_memory');
    if (!tool) throw new Error('expected memory search tool');

    await expect(tool.execute({ keyword: 'transit' })).resolves.toContain('Public transit');
    await expect(tool.execute({ keyword: 'transit' })).resolves.toContain('Tool search_community_memory failed');

    const calls = stats.getLifetimeCounters().toolCalls;
    expect(calls.get('search_community_memory')?.ok).toBe(1);
    expect(calls.get('search_community_memory')?.error).toBe(1);
  });
});
