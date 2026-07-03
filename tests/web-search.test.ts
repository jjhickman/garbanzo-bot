process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SearchConfig = {
  FIRECRAWL_API_KEY?: string;
  BRAVE_SEARCH_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  GOOGLE_SEARCH_ENGINE_ID?: string;
  SEARXNG_BASE_URL?: string;
  WEB_SEARCH_PROVIDER?: 'firecrawl' | 'brave' | 'google' | 'searxng';
};

const warnSpy = vi.fn();

async function importWebSearch(config: SearchConfig) {
  vi.resetModules();
  warnSpy.mockClear();
  vi.doMock('../src/utils/config.js', () => ({
    config: {
      LOG_LEVEL: 'silent',
      ...config,
    },
  }));
  vi.doMock('../src/middleware/logger.js', () => ({
    logger: {
      warn: warnSpy,
    },
  }));

  return import('../src/features/web-search.js');
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('web search feature', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses and formats Brave results with stripped HTML and decoded entities', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      web: {
        results: [
          {
            title: 'Boston trails',
            url: 'https://example.test/trails',
            description: 'One &amp; <b>two</b> &lt;ok&gt; &quot;yes&quot; &#39;now&#39;',
          },
        ],
      },
    }));

    const { handleWebSearch } = await importWebSearch({ BRAVE_SEARCH_API_KEY: 'brave_key' });

    await expect(handleWebSearch('best hikes near Boston')).resolves.toBe([
      '*Boston trails*',
      'https://example.test/trails',
      'One & two <ok> "yes" \'now\'',
    ].join('\n'));

    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    const url = new URL(String(requestUrl));
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(url.searchParams.get('q')).toBe('best hikes near Boston');
    expect(url.searchParams.get('count')).toBe('5');
    expect(requestInit?.headers).toMatchObject({
      'X-Subscription-Token': 'brave_key',
      Accept: 'application/json',
    });
  });

  it('selects Google when only Google search is configured', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      items: [
        {
          title: 'Mongolia',
          link: 'https://example.test/mongolia',
          snippet: 'Capital city facts.',
        },
      ],
    }));

    const { getSearchProviderName, webSearch } = await importWebSearch({
      GOOGLE_API_KEY: 'google_key',
      GOOGLE_SEARCH_ENGINE_ID: 'engine_id',
    });

    expect(getSearchProviderName()).toBe('google');
    await expect(webSearch('capital of Mongolia')).resolves.toEqual([
      {
        title: 'Mongolia',
        url: 'https://example.test/mongolia',
        description: 'Capital city facts.',
      },
    ]);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/customsearch/v1');
    expect(url.searchParams.get('key')).toBe('google_key');
    expect(url.searchParams.get('cx')).toBe('engine_id');
    expect(url.searchParams.get('num')).toBe('5');
  });

  it('parses Firecrawl v2 results with markdown content', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      success: true,
      data: {
        web: [
          {
            title: 'Best sellers',
            url: 'https://example.test/books',
            description: 'Weekly fiction rankings.',
            markdown: '# Fiction\n\n1. Novel One\n2. Novel Two',
          },
        ],
      },
      extra: 'ignored',
    }));

    const { webSearch } = await importWebSearch({ FIRECRAWL_API_KEY: 'firecrawl_key' });

    await expect(webSearch('top fiction')).resolves.toEqual([
      {
        title: 'Best sellers',
        url: 'https://example.test/books',
        description: 'Weekly fiction rankings.',
        content: '# Fiction\n\n1. Novel One\n2. Novel Two',
      },
    ]);

    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe('https://api.firecrawl.dev/v2/search');
    expect(requestInit?.headers).toMatchObject({
      Authorization: 'Bearer firecrawl_key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      query: 'top fiction',
      limit: 5,
      sources: ['web'],
      scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
    });
  });

  it('prefers Firecrawl over Brave when both are configured', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ success: true, data: { web: [] } }));

    const { getSearchProviderName, webSearch } = await importWebSearch({
      FIRECRAWL_API_KEY: 'firecrawl_key',
      BRAVE_SEARCH_API_KEY: 'brave_key',
    });

    expect(getSearchProviderName()).toBe('firecrawl');
    await webSearch('priority check');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.firecrawl.dev/v2/search');
  });

  it('honors WEB_SEARCH_PROVIDER=firecrawl override', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ success: true, data: { web: [] } }));

    const { getSearchProviderName, webSearch } = await importWebSearch({
      FIRECRAWL_API_KEY: 'firecrawl_key',
      BRAVE_SEARCH_API_KEY: 'brave_key',
      WEB_SEARCH_PROVIDER: 'firecrawl',
    });

    expect(getSearchProviderName()).toBe('firecrawl');
    await webSearch('override check');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.firecrawl.dev/v2/search');
  });

  it('falls back from Firecrawl v2 404 to v1 search shape', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(mockJsonResponse({
        success: true,
        data: [
          {
            title: 'Fallback result',
            url: 'https://example.test/fallback',
            description: 'From v1.',
            markdown: 'Recovered markdown',
          },
        ],
      }));

    const { webSearch } = await importWebSearch({ FIRECRAWL_API_KEY: 'firecrawl_key' });

    await expect(webSearch('fallback')).resolves.toEqual([
      {
        title: 'Fallback result',
        url: 'https://example.test/fallback',
        description: 'From v1.',
        content: 'Recovered markdown',
      },
    ]);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.firecrawl.dev/v2/search');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.firecrawl.dev/v1/search');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      query: 'fallback',
      limit: 5,
      scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
    });
  });

  it('selects SearXNG when only its base URL is configured', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      results: [
        { title: 'Local result', url: 'https://example.test/local', content: 'Self-hosted search.' },
      ],
    }));

    const { getSearchProviderName, webSearch } = await importWebSearch({
      SEARXNG_BASE_URL: 'https://search.example.test/searx',
    });

    expect(getSearchProviderName()).toBe('searxng');
    await expect(webSearch('local info')).resolves.toEqual([
      {
        title: 'Local result',
        url: 'https://example.test/local',
        description: 'Self-hosted search.',
      },
    ]);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://search.example.test/searx/search');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('safesearch')).toBe('1');
  });

  it('prefers Brave over Google when both are configured', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ web: { results: [] } }));

    const { getSearchProviderName, webSearch } = await importWebSearch({
      BRAVE_SEARCH_API_KEY: 'brave_key',
      GOOGLE_API_KEY: 'google_key',
      GOOGLE_SEARCH_ENGINE_ID: 'engine_id',
    });

    expect(getSearchProviderName()).toBe('brave');
    await webSearch('priority check');

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin).toBe('https://api.search.brave.com');
  });

  it('honors WEB_SEARCH_PROVIDER override', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ items: [] }));

    const { getSearchProviderName, webSearch } = await importWebSearch({
      BRAVE_SEARCH_API_KEY: 'brave_key',
      GOOGLE_API_KEY: 'google_key',
      GOOGLE_SEARCH_ENGINE_ID: 'engine_id',
      WEB_SEARCH_PROVIDER: 'google',
    });

    expect(getSearchProviderName()).toBe('google');
    await webSearch('override check');

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin).toBe('https://www.googleapis.com');
  });

  it('returns null when WEB_SEARCH_PROVIDER names an unconfigured provider', async () => {
    const { getSearchProviderName } = await importWebSearch({
      GOOGLE_API_KEY: 'google_key',
      GOOGLE_SEARCH_ENGINE_ID: 'engine_id',
      WEB_SEARCH_PROVIDER: 'brave',
    });

    expect(getSearchProviderName()).toBeNull();
    expect(getSearchProviderName()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('throws when no search provider is configured', async () => {
    const { webSearch } = await importWebSearch({});

    await expect(webSearch('anything')).rejects.toThrow('No web search provider configured');
  });

  it('throws on non-2xx provider responses', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response('provider down', { status: 503 }));

    const { webSearch } = await importWebSearch({ BRAVE_SEARCH_API_KEY: 'brave_key' });

    await expect(webSearch('outage')).rejects.toThrow('Brave Search error 503: provider down');
  });

  it('throws when Firecrawl returns success false', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      success: false,
      error: 'quota exceeded',
      data: { web: [] },
    }));

    const { webSearch } = await importWebSearch({ FIRECRAWL_API_KEY: 'firecrawl_key' });

    await expect(webSearch('quota')).rejects.toThrow('Firecrawl Search error: quota exceeded');
  });

  it('formats condensed Firecrawl content for only the first three results', async () => {
    const longContent = `${'x'.repeat(1600)}tail`;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      success: true,
      data: {
        web: [
          {
            title: 'One',
            url: 'https://example.test/one',
            description: 'First.',
            markdown: `A\n\n\n\nB\n\n${longContent}`,
          },
          { title: 'Two', url: 'https://example.test/two', description: 'Second.', markdown: 'Two content' },
          { title: 'Three', url: 'https://example.test/three', description: 'Third.', markdown: 'Three content' },
          { title: 'Four', url: 'https://example.test/four', description: 'Fourth.', markdown: 'Four content' },
        ],
      },
    }));

    const { handleWebSearch } = await importWebSearch({ FIRECRAWL_API_KEY: 'firecrawl_key' });

    const output = await handleWebSearch('content formatting');

    expect(output).toContain(['*One*', 'https://example.test/one', 'First.', 'A\n\nB'].join('\n'));
    expect(output).toContain('x'.repeat(1590));
    expect(output).toContain('…');
    expect(output).toContain('Two content');
    expect(output).toContain('Three content');
    expect(output).not.toContain('Four content');
  });

  it('returns an empty-results message', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ web: { results: [] } }));

    const { handleWebSearch } = await importWebSearch({ BRAVE_SEARCH_API_KEY: 'brave_key' });

    await expect(handleWebSearch('nothing here')).resolves.toBe('No web results for "nothing here".');
  });
});
