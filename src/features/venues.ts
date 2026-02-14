/**
 * Venue search — find places for group outings using Google Places API.
 *
 * Uses the existing GOOGLE_API_KEY (same key as weather).
 * Defaults to Boston area for searches.
 *
 * Commands:
 *   !venue bars in somerville     — search for venues
 *   !venue escape rooms           — search near Boston
 *   !venue bowling alleys boston   — specific search
 */

import { logger } from '../middleware/logger.js';
import { bold } from '../utils/formatting.js';
import { config } from '../utils/config.js';

const PLACES_API = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const DETAILS_API = 'https://maps.googleapis.com/maps/api/place/details/json';
const TIMEOUT_MS = 8_000;

// Boston coordinates for default location bias
const BOSTON_LAT = 42.3601;
const BOSTON_LNG = -71.0589;

interface PlaceResult {
  name: string;
  formatted_address: string;
  rating?: number;
  user_ratings_total?: number;
  price_level?: number;
  opening_hours?: { open_now?: boolean };
  place_id: string;
  business_status?: string;
}

interface PlaceDetails {
  name: string;
  formatted_address: string;
  formatted_phone_number?: string;
  website?: string;
  rating?: number;
  user_ratings_total?: number;
  price_level?: number;
  opening_hours?: {
    open_now?: boolean;
    weekday_text?: string[];
  };
  url?: string; // Google Maps link
}

// ── Google Places API ───────────────────────────────────────────────

async function searchPlaces(query: string): Promise<PlaceResult[]> {
  if (!config.GOOGLE_API_KEY) {
    logger.warn('No GOOGLE_API_KEY — venue search unavailable');
    return [];
  }

  // Add "Boston" if no location is mentioned
  const locationWords = /\b(boston|cambridge|somerville|brookline|allston|brighton|back bay|south end|north end|dorchester|jamaica plain|jp|fenway|seaport|charlestown|quincy|medford|malden|revere|newton|watertown|waltham)\b/i;
  const searchQuery = locationWords.test(query) ? query : `${query} Boston MA`;

  const params = new URLSearchParams({
    query: searchQuery,
    key: config.GOOGLE_API_KEY,
    location: `${BOSTON_LAT},${BOSTON_LNG}`,
    radius: '15000', // 15km radius
  });

  try {
    const response = await fetch(`${PLACES_API}?${params}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return [];

    const data = await response.json() as { results: PlaceResult[]; status: string };
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      logger.error({ status: data.status }, 'Google Places API error');
      return [];
    }

    return data.results.slice(0, 5);
  } catch (err) {
    logger.error({ err }, 'Google Places search failed');
    return [];
  }
}

async function getPlaceDetails(placeId: string): Promise<PlaceDetails | null> {
  if (!config.GOOGLE_API_KEY) return null;

  const params = new URLSearchParams({
    place_id: placeId,
    key: config.GOOGLE_API_KEY,
    fields: 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,price_level,opening_hours,url',
  });

  try {
    const response = await fetch(`${DETAILS_API}?${params}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const data = await response.json() as { result: PlaceDetails; status: string };
    if (data.status !== 'OK') return null;

    return data.result;
  } catch (err) {
    logger.error({ err }, 'Google Places details failed');
    return null;
  }
}

// ── Formatting ──────────────────────────────────────────────────────

function priceLevel(level: number | undefined): string {
  if (level === undefined) return '';
  return ' · ' + '$'.repeat(level);
}

function formatPlaceList(places: PlaceResult[], query: string): string {
  const lines: string[] = [
    `📍 ${bold(`Venues: ${query}`)}`,
    '',
  ];

  for (const place of places) {
    const rating = place.rating ? ` ⭐${place.rating}` : '';
    const reviews = place.user_ratings_total ? ` (${place.user_ratings_total})` : '';
    const price = priceLevel(place.price_level);
    const status = place.opening_hours?.open_now === true ? ' · 🟢 Open' : place.opening_hours?.open_now === false ? ' · 🔴 Closed' : '';
    const addr = place.formatted_address.replace(/, USA$/, '').replace(/, United States$/, '');

    lines.push(`• ${bold(place.name)}${rating}${reviews}${price}${status}`);
    lines.push(`  ${addr}`);
  }

  if (places.length > 0) {
    lines.push('');
    lines.push(`_Use "!venue details [name]" for phone, hours, and website._`);
  }

  return lines.join('\n');
}

function formatPlaceDetails(place: PlaceDetails): string {
  const lines: string[] = [
    `📍 ${bold(place.name)}`,
    '',
  ];

  if (place.formatted_address) {
    lines.push(`${bold('Address')}: ${place.formatted_address.replace(/, USA$/, '')}`);
  }
  if (place.formatted_phone_number) {
    lines.push(`${bold('Phone')}: ${place.formatted_phone_number}`);
  }
  if (place.rating) {
    const stars = '⭐'.repeat(Math.round(place.rating));
    lines.push(`${bold('Rating')}: ${stars} ${place.rating}/5 (${place.user_ratings_total ?? 0} reviews)${priceLevel(place.price_level)}`);
  }

  const status = place.opening_hours?.open_now === true ? '🟢 Open now' : place.opening_hours?.open_now === false ? '🔴 Closed now' : null;
  if (status) lines.push(`${bold('Status')}: ${status}`);

  if (place.opening_hours?.weekday_text?.length) {
    lines.push('');
    lines.push(bold('Hours:'));
    for (const day of place.opening_hours.weekday_text) {
      lines.push(`  ${day}`);
    }
  }

  if (place.website) lines.push(`\n${bold('Website')}: ${place.website}`);
  if (place.url) lines.push(`${bold('Maps')}: ${place.url}`);

  return lines.join('\n');
}

// ── Public handler ──────────────────────────────────────────────────

export async function handleVenues(query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return getVenueHelp();

  if (!config.GOOGLE_API_KEY) {
    return '📍 Venue search is unavailable — no Google API key configured.';
  }

  const lower = trimmed.toLowerCase();

  // Details lookup — "details [name]"
  if (lower.startsWith('details ')) {
    const name = trimmed.replace(/^details\s+/i, '');
    const places = await searchPlaces(name);
    if (places.length === 0) return `📍 No venue found matching "${name}".`;
    const details = await getPlaceDetails(places[0].place_id);
    if (!details) return `📍 Couldn't get details for "${places[0].name}".`;
    return formatPlaceDetails(details);
  }

  // Regular search
  const places = await searchPlaces(trimmed);
  if (places.length === 0) return `📍 No venues found for "${trimmed}" near Boston.`;

  return formatPlaceList(places, trimmed);
}

function getVenueHelp(): string {
  return [
    `📍 ${bold('Venue Search')}`,
    '',
    '  !venue bars in somerville',
    '  !venue escape rooms',
    '  !venue bowling alleys',
    '  !venue details [name]',
    '',
    '_Searches near Boston by default._',
  ].join('\n');
}
