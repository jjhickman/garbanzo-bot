import { z } from 'zod';
import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { bold } from '../utils/formatting.js';

const TIMEOUT_MS = 10_000;
const DEFAULT_COUNT = 5;
const SEARCH_PROVIDERS = ['brave', 'google', 'searxng'] as const;

type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
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
  if (provider === 'brave') return !!config.BRAVE_SEARCH_API_KEY;
  if (provider === 'google') return !!config.GOOGLE_API_KEY && !!config.GOOGLE_SEARCH_ENGINE_ID;
  return !!config.SEARXNG_BASE_URL;
}

// ── Public API ───────────────────────────────────────────────────────

export async function webSearch(query: string, count = DEFAULT_COUNT): Promise<WebSearchResult[]> {
  const provider = getSearchProviderName();
  if (!provider) {
    throw new Error('No web search provider configured. Set BRAVE_SEARCH_API_KEY, GOOGLE_API_KEY with GOOGLE_SEARCH_ENGINE_ID, or SEARXNG_BASE_URL.');
  }

  if (provider === 'brave') return braveSearch(query, count);
  if (provider === 'google') return googleSearch(query, count);
  return searxngSearch(query, count);
}

export async function handleWebSearch(query: string): Promise<string> {
  const results = await webSearch(query);
  if (results.length === 0) return `No web results for "${query}".`;

  return results
    .map((result) => [
      bold(result.title),
      result.url,
      result.description,
    ].join('\n'))
    .join('\n\n');
}

// ── API calls ────────────────────────────────────────────────────────

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
