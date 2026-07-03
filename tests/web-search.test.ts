process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SearchConfig = {
  BRAVE_SEARCH_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  GOOGLE_SEARCH_ENGINE_ID?: string;
  SEARXNG_BASE_URL?: string;
  WEB_SEARCH_PROVIDER?: 'brave' | 'google' | 'searxng';
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

  it('returns an empty-results message', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ web: { results: [] } }));

    const { handleWebSearch } = await importWebSearch({ BRAVE_SEARCH_API_KEY: 'brave_key' });

    await expect(handleWebSearch('nothing here')).resolves.toBe('No web results for "nothing here".');
  });
});
