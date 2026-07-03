import { z } from 'zod';
import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { bold } from '../utils/formatting.js';

const TIMEOUT_MS = 10_000;
const FIRECRAWL_TIMEOUT_MS = 25_000;
const DEFAULT_COUNT = 5;
const SEARCH_PROVIDERS = ['firecrawl', 'brave', 'google', 'searxng'] as const;
const FIRECRAWL_V2_URL = 'https://api.firecrawl.dev/v2/search';
const FIRECRAWL_V1_URL = 'https://api.firecrawl.dev/v1/search';
const CONTENT_RESULT_LIMIT = 3;
const CONTENT_MAX_CHARS = 1600;

type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  content?: string;
}

// ── Zod schemas ─────────────────────────────────────────────────────

const BraveSearchResponseSchema = z.object({
  web: z.object({
    results: z.array(z.object({
      title: z.string(),
      url: z.string(),
      description: z.string().optional().default(''),
    })).default([]),
  }).optional(),
});

const GoogleSearchResponseSchema = z.object({
  items: z.array(z.object({
    title: z.string(),
    link: z.string(),
    snippet: z.string().optional().default(''),
  })).optional().default([]),
});

const SearxngSearchResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    content: z.string().optional().default(''),
  })).optional().default([]),
});

const FirecrawlResultSchema = z.object({
  url: z.string(),
  title: z.string().optional().default(''),
  description: z.string().optional().default(''),
  markdown: z.string().optional(),
}).passthrough();

const FirecrawlV2ResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    web: z.array(FirecrawlResultSchema).optional().default([]),
  }).passthrough(),
}).passthrough();

const FirecrawlV1ResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(FirecrawlResultSchema).optional().default([]),
}).passthrough();

// ── Provider resolution ──────────────────────────────────────────────

const warnedUnconfiguredOverrides = new Set<SearchProvider>();

export function getSearchProviderName(): SearchProvider | null {
  const override = config.WEB_SEARCH_PROVIDER;
  if (override) {
    if (isProviderConfigured(override)) return override;

    if (!warnedUnconfiguredOverrides.has(override)) {
      warnedUnconfiguredOverrides.add(override);
      logger.warn({ provider: override }, 'Configured web search provider is unavailable');
    }
    return null;
  }

  return SEARCH_PROVIDERS.find((provider) => isProviderConfigured(provider)) ?? null;
}

function isProviderConfigured(provider: SearchProvider): boolean {
  if (provider === 'firecrawl') return !!config.FIRECRAWL_API_KEY;
  if (provider === 'brave') return !!config.BRAVE_SEARCH_API_KEY;
  if (provider === 'google') return !!config.GOOGLE_API_KEY && !!config.GOOGLE_SEARCH_ENGINE_ID;
  return !!config.SEARXNG_BASE_URL;
}

// ── Public API ───────────────────────────────────────────────────────

export async function webSearch(query: string, count = DEFAULT_COUNT): Promise<WebSearchResult[]> {
  const provider = getSearchProviderName();
  if (!provider) {
    throw new Error('No web search provider configured. Set FIRECRAWL_API_KEY, BRAVE_SEARCH_API_KEY, GOOGLE_API_KEY with GOOGLE_SEARCH_ENGINE_ID, or SEARXNG_BASE_URL.');
  }

  if (provider === 'firecrawl') return firecrawlSearch(query, count);
  if (provider === 'brave') return braveSearch(query, count);
  if (provider === 'google') return googleSearch(query, count);
  return searxngSearch(query, count);
}

export async function handleWebSearch(query: string): Promise<string> {
  const results = await webSearch(query);
  if (results.length === 0) return `No web results for "${query}".`;

  return results
    .map((result, index) => formatWebSearchResult(result, index))
    .join('\n\n');
}

// ── API calls ────────────────────────────────────────────────────────

async function firecrawlSearch(query: string, count: number): Promise<WebSearchResult[]> {
  const body = {
    query,
    limit: normalizeCount(count),
    sources: ['web'],
    scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
  };

  const res = await fetchFirecrawl(FIRECRAWL_V2_URL, body);
  if (res.status === 404) return firecrawlSearchV1(query, count);

  if (!res.ok) {
    throw new Error(`Firecrawl Search error ${res.status}: ${await res.text()}`);
  }

  const data = FirecrawlV2ResponseSchema.parse(await res.json());
  if (!data.success) throw new Error(`Firecrawl Search error: ${firecrawlDetail(data)}`);
  return data.data.web.map(mapFirecrawlResult);
}

async function firecrawlSearchV1(query: string, count: number): Promise<WebSearchResult[]> {
  const res = await fetchFirecrawl(FIRECRAWL_V1_URL, {
    query,
    limit: normalizeCount(count),
    scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
  });

  if (!res.ok) {
    throw new Error(`Firecrawl Search error ${res.status}: ${await res.text()}`);
  }

  const data = FirecrawlV1ResponseSchema.parse(await res.json());
  if (!data.success) throw new Error(`Firecrawl Search error: ${firecrawlDetail(data)}`);
  return data.data.map(mapFirecrawlResult);
}

async function fetchFirecrawl(url: string, body: object): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.FIRECRAWL_API_KEY ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
  });
}

async function braveSearch(query: string, count: number): Promise<WebSearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(normalizeCount(count)));

  const res = await fetch(url.toString(), {
    headers: {
      'X-Subscription-Token': config.BRAVE_SEARCH_API_KEY ?? '',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Brave Search error ${res.status}: ${await res.text()}`);
  }

  const data = BraveSearchResponseSchema.parse(await res.json());
  return (data.web?.results ?? []).map((result) => ({
    title: result.title,
    url: result.url,
    description: stripHtmlAndDecodeEntities(result.description),
  }));
}

async function googleSearch(query: string, count: number): Promise<WebSearchResult[]> {
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', config.GOOGLE_API_KEY ?? '');
  url.searchParams.set('cx', config.GOOGLE_SEARCH_ENGINE_ID ?? '');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(normalizeCount(count)));

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Google Custom Search error ${res.status}: ${await res.text()}`);
  }

  const data = GoogleSearchResponseSchema.parse(await res.json());
  return data.items.map((item) => ({
    title: item.title,
    url: item.link,
    description: item.snippet,
  }));
}

async function searxngSearch(query: string, count: number): Promise<WebSearchResult[]> {
  const url = new URL(`${(config.SEARXNG_BASE_URL ?? '').replace(/\/$/, '')}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '1');

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`SearXNG error ${res.status}: ${await res.text()}`);
  }

  const data = SearxngSearchResponseSchema.parse(await res.json());
  return data.results.slice(0, normalizeCount(count)).map((result) => ({
    title: result.title,
    url: result.url,
    description: result.content,
  }));
}

// ── Formatting helpers ───────────────────────────────────────────────

function mapFirecrawlResult(result: z.infer<typeof FirecrawlResultSchema>): WebSearchResult {
  return {
    title: result.title,
    url: result.url,
    description: result.description,
    content: result.markdown,
  };
}

function firecrawlDetail(data: object): string {
  if ('error' in data && typeof data.error === 'string') return data.error;
  return 'success=false';
}

function formatWebSearchResult(result: WebSearchResult, index: number): string {
  const parts = [
    bold(result.title),
    result.url,
    result.description,
  ];

  if (result.content && index < CONTENT_RESULT_LIMIT) {
    parts.push(condenseContent(result.content));
  }

  return parts.join('\n');
}

function condenseContent(content: string): string {
  const condensed = content.replace(/\n{3,}/g, '\n\n').trim();
  if (condensed.length <= CONTENT_MAX_CHARS) return condensed;
  return `${condensed.slice(0, CONTENT_MAX_CHARS - 1)}…`;
}

function normalizeCount(count: number): number {
  if (!Number.isFinite(count)) return DEFAULT_COUNT;
  return Math.max(1, Math.min(DEFAULT_COUNT, Math.floor(count)));
}

function stripHtmlAndDecodeEntities(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
