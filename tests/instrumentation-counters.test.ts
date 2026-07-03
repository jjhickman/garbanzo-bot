process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('instrumentation lifetime counters', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock('../src/features/web-search.js');
    vi.doUnmock('../src/utils/db.js');
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

  it('allows larger web_search tool results', async () => {
    const longResult = 'w'.repeat(5500);
    vi.doMock('../src/utils/config.js', () => ({
      config: { AI_TOOL_CALLING: true, LOG_LEVEL: 'silent' },
    }));
    vi.doMock('../src/features/web-search.js', () => ({
      getSearchProviderName: () => 'firecrawl',
      handleWebSearch: vi.fn<() => Promise<string>>().mockResolvedValue(longResult),
    }));

    const { getEnabledTools } = await import('../src/ai/tools.js');
    const tool = getEnabledTools().find((candidate) => candidate.name === 'web_search');
    if (!tool) throw new Error('expected web_search tool');

    await expect(tool.execute({ query: 'top 10 books' })).resolves.toBe(longResult);
  });

  it('keeps non-web_search tool results capped at 1500 chars', async () => {
    const longFact = 'm'.repeat(2000);
    vi.doMock('../src/utils/config.js', () => ({
      config: { AI_TOOL_CALLING: true, LOG_LEVEL: 'silent' },
    }));
    vi.doMock('../src/utils/db.js', () => ({
      searchMemory: vi.fn<() => Promise<Array<{ fact: string; category: string }>>>()
        .mockResolvedValue([{ fact: longFact, category: 'note' }]),
    }));

    const { getEnabledTools } = await import('../src/ai/tools.js');
    const tool = getEnabledTools().find((candidate) => candidate.name === 'search_community_memory');
    if (!tool) throw new Error('expected memory search tool');

    const result = await tool.execute({ keyword: 'memory' });

    expect(result).toHaveLength(1500);
    expect(result.endsWith('...')).toBe(true);
  });

  it('gates web search tools by configured search provider', async () => {
    vi.doMock('../src/utils/config.js', () => ({
      config: { AI_TOOL_CALLING: true, LOG_LEVEL: 'silent' },
    }));

    let toolsModule = await import('../src/ai/tools.js');
    expect(toolsModule.getEnabledTools().some((tool) => tool.name === 'web_search')).toBe(false);

    vi.resetModules();
    vi.doMock('../src/utils/config.js', () => ({
      config: {
        AI_TOOL_CALLING: true,
        LOG_LEVEL: 'silent',
        BRAVE_SEARCH_API_KEY: 'brave_key',
      },
    }));

    toolsModule = await import('../src/ai/tools.js');
    expect(toolsModule.getEnabledTools().some((tool) => tool.name === 'web_search')).toBe(true);
  });
});
