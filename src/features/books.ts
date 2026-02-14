/**
 * Book Club feature — search and look up books for the community book club.
 *
 * Primary: Open Library API (free, no key, Internet Archive)
 * Fallback: Google Books API (free with existing GOOGLE_API_KEY)
 *
 * Commands:
 *   !book dune                — search by title
 *   !book author frank herbert — search by author
 *   !book isbn 9780441013593  — lookup by ISBN
 */

import { logger } from '../middleware/logger.js';
import { bold } from '../utils/formatting.js';

const OL_SEARCH = 'https://openlibrary.org/search.json';
const OL_WORKS = 'https://openlibrary.org';
const TIMEOUT_MS = 8_000;

const USER_AGENT = 'GarbanzoBot/1.0 (WhatsApp community bot)';

// ── Open Library API ────────────────────────────────────────────────

interface OLSearchDoc {
  key: string;           // e.g. "/works/OL45804W"
  title: string;
  author_name?: string[];
  first_publish_year?: number;
  number_of_pages_median?: number;
  subject?: string[];
  cover_i?: number;
  isbn?: string[];
  ratings_average?: number;
  ratings_count?: number;
  want_to_read_count?: number;
  currently_reading_count?: number;
  already_read_count?: number;
  edition_count?: number;
}

interface OLWork {
  title: string;
  description?: string | { value: string };
  subjects?: string[];
  covers?: number[];
}

async function olFetch<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch (err) {
    logger.error({ err, url }, 'Open Library API fetch failed');
    return null;
  }
}

async function searchBooks(query: string, field?: 'title' | 'author'): Promise<OLSearchDoc[]> {
  const params = new URLSearchParams({ limit: '5', fields: 'key,title,author_name,first_publish_year,number_of_pages_median,subject,cover_i,isbn,ratings_average,ratings_count,want_to_read_count,currently_reading_count,already_read_count,edition_count' });

  if (field === 'author') {
    params.set('author', query);
  } else if (field === 'title') {
    params.set('title', query);
  } else {
    params.set('q', query);
  }

  const data = await olFetch<{ docs: OLSearchDoc[] }>(`${OL_SEARCH}?${params}`);
  return data?.docs ?? [];
}

async function getWorkDescription(workKey: string): Promise<string | null> {
  const work = await olFetch<OLWork>(`${OL_WORKS}${workKey}.json`);
  if (!work?.description) return null;

  if (typeof work.description === 'string') return work.description;
  return work.description.value ?? null;
}

async function lookupByISBN(isbn: string): Promise<OLSearchDoc[]> {
  const params = new URLSearchParams({ q: `isbn:${isbn}`, limit: '1', fields: 'key,title,author_name,first_publish_year,number_of_pages_median,subject,cover_i,isbn,ratings_average,ratings_count,want_to_read_count,currently_reading_count,already_read_count,edition_count' });
  const data = await olFetch<{ docs: OLSearchDoc[] }>(`${OL_SEARCH}?${params}`);
  return data?.docs ?? [];
}

// ── Formatting ──────────────────────────────────────────────────────

function formatBookResult(doc: OLSearchDoc, description?: string | null): string {
  const lines: string[] = [
    `📚 ${bold(doc.title)}`,
  ];

  if (doc.author_name?.length) {
    lines.push(`_by ${doc.author_name.join(', ')}_`);
  }

  lines.push('');

  if (doc.first_publish_year) lines.push(`${bold('Published')}: ${doc.first_publish_year}`);
  if (doc.number_of_pages_median) lines.push(`${bold('Pages')}: ${doc.number_of_pages_median}`);
  if (doc.edition_count) lines.push(`${bold('Editions')}: ${doc.edition_count}`);

  if (doc.ratings_average) {
    const stars = '⭐'.repeat(Math.round(doc.ratings_average));
    lines.push(`${bold('Rating')}: ${stars} ${doc.ratings_average.toFixed(1)}/5 (${doc.ratings_count ?? 0} ratings)`);
  }

  // Reading stats from Open Library community
  const readStats: string[] = [];
  if (doc.want_to_read_count) readStats.push(`${doc.want_to_read_count} want to read`);
  if (doc.currently_reading_count) readStats.push(`${doc.currently_reading_count} reading`);
  if (doc.already_read_count) readStats.push(`${doc.already_read_count} read`);
  if (readStats.length) lines.push(`${bold('Community')}: ${readStats.join(' · ')}`);

  if (doc.subject?.length) {
    const subjects = doc.subject.slice(0, 6).join(', ');
    lines.push(`${bold('Subjects')}: ${subjects}`);
  }

  if (description) {
    lines.push('');
    // Clean up markdown/HTML from Open Library descriptions
    const clean = description.replace(/\r\n/g, '\n').replace(/\[.*?\]\(.*?\)/g, '').trim();
    lines.push(clean.length > 600 ? clean.slice(0, 597) + '...' : clean);
  }

  return lines.join('\n');
}

function formatSearchResults(docs: OLSearchDoc[]): string {
  const lines: string[] = [
    `📚 ${bold('Search Results')} (${docs.length} found)`,
    '',
  ];

  for (const doc of docs) {
    const author = doc.author_name?.[0] ?? 'Unknown author';
    const year = doc.first_publish_year ?? '?';
    const rating = doc.ratings_average ? ` ⭐${doc.ratings_average.toFixed(1)}` : '';
    lines.push(`• ${bold(doc.title)} — ${author} (${year})${rating}`);
  }

  lines.push('');
  lines.push(`_Use "!book [title]" for details on a specific book._`);

  return lines.join('\n');
}

// ── Public handler ──────────────────────────────────────────────────

/**
 * Handle book club commands. Expects the query AFTER the command prefix.
 *
 * Routing:
 * - "author [name]" → search by author
 * - "isbn [number]" → ISBN lookup
 * - anything else → search by title/general query, show top result with description
 */
export async function handleBooks(query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return getBookHelp();

  const lower = trimmed.toLowerCase();

  // Author search
  if (lower.startsWith('author ') || lower.startsWith('by ')) {
    const authorQuery = trimmed.replace(/^(author|by)\s+/i, '');
    const docs = await searchBooks(authorQuery, 'author');
    if (docs.length === 0) return `📚 No books found by "${authorQuery}".`;
    return formatSearchResults(docs);
  }

  // ISBN lookup
  if (lower.startsWith('isbn ')) {
    const isbn = trimmed.replace(/^isbn\s+/i, '').replace(/[-\s]/g, '');
    const docs = await lookupByISBN(isbn);
    if (docs.length === 0) return `📚 No book found for ISBN ${isbn}.`;
    const doc = docs[0];
    const desc = await getWorkDescription(doc.key);
    return formatBookResult(doc, desc);
  }

  // General search — show detailed result for top match
  const docs = await searchBooks(trimmed, 'title');
  if (docs.length === 0) {
    // Fallback to general search
    const generalDocs = await searchBooks(trimmed);
    if (generalDocs.length === 0) return `📚 No books found matching "${trimmed}".`;
    if (generalDocs.length === 1 || generalDocs[0].title.toLowerCase() === trimmed.toLowerCase()) {
      const desc = await getWorkDescription(generalDocs[0].key);
      return formatBookResult(generalDocs[0], desc);
    }
    return formatSearchResults(generalDocs);
  }

  // If exact-ish title match, show details; otherwise show list
  if (docs.length === 1 || docs[0].title.toLowerCase().includes(trimmed.toLowerCase())) {
    const desc = await getWorkDescription(docs[0].key);
    return formatBookResult(docs[0], desc);
  }

  return formatSearchResults(docs);
}

function getBookHelp(): string {
  return [
    `📚 ${bold('Book Club Commands')}`,
    '',
    '  !book [title] — search by title',
    '  !book author [name] — search by author',
    '  !book isbn [number] — lookup by ISBN',
    '',
    '_Powered by Open Library._',
  ].join('\n');
}
