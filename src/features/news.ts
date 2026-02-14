import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { bold } from '../utils/formatting.js';

/**
 * News search feature — NewsAPI integration.
 *
 * Provides news search and top headlines.
 * Free tier: 100 requests/day, 24-hour delay on articles.
 */

const NEWS_BASE = 'https://newsapi.org/v2';

// ── Types ────────────────────────────────────────────────────────────

interface Article {
  source: { name: string };
  title: string;
  description: string | null;
  url: string;
  publishedAt: string;
}

interface NewsAPIResponse {
  status: 'ok' | 'error';
  totalResults: number;
  articles: Article[];
  code?: string;
  message?: string;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Handle a news query. Returns a formatted WhatsApp message string.
 */
export async function handleNews(query: string): Promise<string> {
  if (!config.NEWSAPI_KEY) {
    return '🫘 News search is unavailable — no NewsAPI key configured.';
  }

  try {
    const searchTerm = extractSearchTerm(query);

    if (!searchTerm) {
      // No specific topic — show Boston top headlines
      return await getTopHeadlines();
    }

    return await searchNews(searchTerm);
  } catch (err) {
    logger.error({ err, query }, 'News feature error');
    return '🫘 Couldn\'t fetch news right now. Try again in a moment.';
  }
}

// ── Query parsing ────────────────────────────────────────────────────

function extractSearchTerm(query: string): string | null {
  // "news about X", "news on X", "X news", "latest news on X"
  const patterns = [
    /news\s+(?:about|on|for|regarding)\s+(.+?)(?:\?|$)/i,
    /(?:latest|recent|top)\s+(?:news\s+)?(?:about|on|for)\s+(.+?)(?:\?|$)/i,
    /what(?:'s| is)\s+(?:the\s+)?(?:latest|news)\s+(?:about|on|with)\s+(.+?)(?:\?|$)/i,
  ];

  for (const pattern of patterns) {
    const match = query.match(pattern);
    if (match) return match[1].trim();
  }

  // If query is just "news" or "top news" or "headlines", return null for general headlines
  if (/^(?:news|top\s+news|headlines|top\s+headlines)$/i.test(query.trim())) {
    return null;
  }

  // Try to extract a meaningful keyword by removing "news" and common words
  const cleaned = query
    .replace(/\b(news|latest|recent|search|find|show|tell|me|about|the|what|whats)\b/gi, '')
    .trim();

  return cleaned.length >= 3 ? cleaned : null;
}

// ── API calls ────────────────────────────────────────────────────────

async function searchNews(searchTerm: string): Promise<string> {
  const url = new URL(`${NEWS_BASE}/everything`);
  url.searchParams.set('q', searchTerm);
  url.searchParams.set('language', 'en');
  url.searchParams.set('sortBy', 'publishedAt');
  url.searchParams.set('pageSize', '5');

  const res = await fetch(url.toString(), {
    headers: { 'X-Api-Key': config.NEWSAPI_KEY! },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`NewsAPI error ${res.status}: ${errText}`);
  }

  const data = await res.json() as NewsAPIResponse;

  if (data.status !== 'ok') {
    throw new Error(`NewsAPI error: ${data.code} — ${data.message}`);
  }

  if (data.articles.length === 0) {
    return `📰 No recent news found for "${searchTerm}".`;
  }

  return formatArticles(data.articles, `News: "${searchTerm}"`);
}

async function getTopHeadlines(): Promise<string> {
  const url = new URL(`${NEWS_BASE}/top-headlines`);
  url.searchParams.set('country', 'us');
  url.searchParams.set('pageSize', '5');

  const res = await fetch(url.toString(), {
    headers: { 'X-Api-Key': config.NEWSAPI_KEY! },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`NewsAPI error ${res.status}: ${errText}`);
  }

  const data = await res.json() as NewsAPIResponse;

  if (data.status !== 'ok') {
    throw new Error(`NewsAPI error: ${data.code} — ${data.message}`);
  }

  if (data.articles.length === 0) {
    return '📰 No headlines available right now.';
  }

  return formatArticles(data.articles, 'Top Headlines');
}

// ── Formatting ───────────────────────────────────────────────────────

function formatArticles(articles: Article[], title: string): string {
  const lines = [`📰 ${bold(title)}`, ''];

  for (const article of articles) {
    const timeAgo = formatTimeAgo(article.publishedAt);
    const source = article.source.name;
    lines.push(`${bold(article.title)}`);
    lines.push(`_${source} · ${timeAgo}_`);
    lines.push(`${article.url}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(diff / 3600000);

  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
