import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { bold } from '../utils/formatting.js';

/**
 * MBTA Transit feature — real-time predictions, alerts, and schedules
 * for Boston's public transit system.
 */

const MBTA_BASE = 'https://api-v3.mbta.com';

// ── Types ────────────────────────────────────────────────────────────

interface MbtaPrediction {
  id: string;
  attributes: {
    arrival_time: string | null;
    departure_time: string | null;
    direction_id: number;
    status: string | null;
  };
  relationships: {
    route: { data: { id: string } };
    stop: { data: { id: string } };
  };
}

interface MbtaAlert {
  id: string;
  attributes: {
    header: string;
    description: string | null;
    effect: string;
    severity: number;
    lifecycle: string;
    active_period: Array<{ start: string; end: string | null }>;
    informed_entity: Array<{
      route?: string;
      stop?: string;
      route_type?: number;
    }>;
  };
}

interface MbtaSchedule {
  id: string;
  attributes: {
    arrival_time: string | null;
    departure_time: string | null;
    direction_id: number;
  };
  relationships: {
    route: { data: { id: string } };
    stop: { data: { id: string } };
    trip: { data: { id: string } };
  };
}

interface MbtaStop {
  id: string;
  attributes: { name: string };
}

interface MbtaRoute {
  id: string;
  attributes: {
    long_name: string;
    short_name: string;
    direction_names: string[];
    color: string;
  };
}

interface JsonApiResponse<T> {
  data: T[];
  included?: Array<MbtaStop | MbtaRoute | Record<string, unknown>>;
}

// ── Known stations & routes ──────────────────────────────────────────

const ROUTE_ALIASES: Record<string, string> = {
  'red': 'Red',
  'red line': 'Red',
  'orange': 'Orange',
  'orange line': 'Orange',
  'blue': 'Blue',
  'blue line': 'Blue',
  'green': 'Green-B,Green-C,Green-D,Green-E',
  'green line': 'Green-B,Green-C,Green-D,Green-E',
  'green-b': 'Green-B',
  'green-c': 'Green-C',
  'green-d': 'Green-D',
  'green-e': 'Green-E',
  'mattapan': 'Mattapan',
};

const STATION_ALIASES: Record<string, string> = {
  'south station': 'place-sstat',
  'north station': 'place-north',
  'park street': 'place-pktrm',
  'park st': 'place-pktrm',
  'downtown crossing': 'place-dwnxg',
  'dtx': 'place-dwnxg',
  'alewife': 'place-alfcl',
  'davis': 'place-davis',
  'harvard': 'place-harsq',
  'kendall': 'place-knncl',
  'mit': 'place-knncl',
  'central': 'place-cntsq',
  'central square': 'place-cntsq',
  'andrew': 'place-andrw',
  'jfk': 'place-jfk',
  'jfk/umass': 'place-jfk',
  'broadway': 'place-brdwy',
  'charles/mgh': 'place-chmnl',
  'back bay': 'place-bbsta',
  'ruggles': 'place-ruMDY',
  'haymarket': 'place-haecl',
  'state': 'place-state',
  'government center': 'place-gover',
  'copley': 'place-coecl',
  'fenway': 'place-fenwy',
  'kenmore': 'place-kencl',
  'lechmere': 'place-lech',
  'wonderland': 'place-wondl',
  'airport': 'place-apts',
  'aquarium': 'place-aqucl',
  'maverick': 'place-mvbcl',
  'forest hills': 'place-forhl',
  'oak grove': 'place-ogmnl',
  'assembly': 'place-astao',
  'sullivan': 'place-sull',
  'tufts': 'place-tumnl',
  'chinatown': 'place-chncl',
  'porter': 'place-portr',
  'porter square': 'place-portr',
  'braintree': 'place-brntn',
  'quincy center': 'place-qnctr',
  'quincy adams': 'place-qamnl',
  'ashmont': 'place-asmnl',
};

const ROUTE_EMOJI: Record<string, string> = {
  'Red': '🔴',
  'Orange': '🟠',
  'Blue': '🔵',
  'Green-B': '🟢',
  'Green-C': '🟢',
  'Green-D': '🟢',
  'Green-E': '🟢',
  'Mattapan': '🔴',
};

const EFFECT_EMOJI: Record<string, string> = {
  'DELAY': '⏰',
  'SHUTTLE': '🚌',
  'SUSPENSION': '🚫',
  'DETOUR': '↩️',
  'STOP_CLOSURE': '🚧',
  'STATION_CLOSURE': '🚧',
  'ELEVATOR_CLOSURE': '🛗',
  'ESCALATOR_CLOSURE': '🛗',
  'SERVICE_CHANGE': '⚠️',
  'EXTRA_SERVICE': '➕',
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Handle a transit query. Returns a formatted WhatsApp message string.
 */
export async function handleTransit(query: string): Promise<string> {
  if (!config.MBTA_API_KEY) {
    return '🫘 Transit info is unavailable — no MBTA API key configured.';
  }

  try {
    // Determine what the user is asking about
    const intent = parseTransitIntent(query);

    if (intent.type === 'alerts') {
      return await getAlerts(intent.route);
    }
    if (intent.type === 'predictions') {
      return await getPredictions(intent.stop, intent.route);
    }
    if (intent.type === 'schedule') {
      return await getSchedule(intent.stop, intent.route);
    }
    // Default: show alerts for all subway lines
    return await getAlerts();
  } catch (err) {
    logger.error({ err, query }, 'Transit feature error');
    return '🫘 Couldn\'t fetch transit info right now. Try again in a moment.';
  }
}

// ── Intent parsing ───────────────────────────────────────────────────

interface TransitIntent {
  type: 'alerts' | 'predictions' | 'schedule';
  route?: string;
  stop?: string;
}

function parseTransitIntent(query: string): TransitIntent {
  const lower = query.toLowerCase();

  // Extract route
  const route = resolveRoute(lower);

  // Extract station
  const stop = resolveStation(lower);

  // Determine intent
  if (/\balert|disruption|issue|problem|status\b/i.test(query)) {
    return { type: 'alerts', route };
  }

  if (/\bschedule|timetable\b/i.test(query)) {
    return { type: 'schedule', route, stop };
  }

  // If they mention a specific stop, show predictions (next arrivals)
  if (stop) {
    return { type: 'predictions', route, stop };
  }

  // If they mention a route but no stop, show alerts for that route
  if (route) {
    return { type: 'alerts', route };
  }

  // Default: alerts overview
  return { type: 'alerts' };
}

function resolveRoute(text: string): string | undefined {
  for (const [alias, routeId] of Object.entries(ROUTE_ALIASES)) {
    if (text.includes(alias)) return routeId;
  }
  return undefined;
}

function resolveStation(text: string): string | undefined {
  // Sort by longest alias first to match "south station" before "station"
  const sorted = Object.entries(STATION_ALIASES)
    .sort(([a], [b]) => b.length - a.length);

  for (const [alias, stopId] of sorted) {
    if (text.includes(alias)) return stopId;
  }
  return undefined;
}

// ── API calls ────────────────────────────────────────────────────────

async function mbtaFetch<T>(endpoint: string, params: Record<string, string>): Promise<JsonApiResponse<T>> {
  const url = new URL(`${MBTA_BASE}${endpoint}`);
  url.searchParams.set('api_key', config.MBTA_API_KEY!);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  logger.debug({ url: url.toString() }, 'MBTA API call');

  const res = await fetch(url.toString(), {
    headers: { 'accept-encoding': 'gzip' },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MBTA API error ${res.status}: ${errText}`);
  }

  return await res.json() as JsonApiResponse<T>;
}

// ── Alerts ───────────────────────────────────────────────────────────

async function getAlerts(route?: string): Promise<string> {
  const params: Record<string, string> = {
    'filter[activity]': 'BOARD,EXIT,RIDE',
    'sort': '-severity',
  };

  if (route) {
    params['filter[route]'] = route;
  } else {
    // All subway lines
    params['filter[route]'] = 'Red,Orange,Blue,Green-B,Green-C,Green-D,Green-E,Mattapan';
  }

  const data = await mbtaFetch<MbtaAlert>('/alerts', params);

  // Filter to active/upcoming, severity >= 3
  const now = new Date();
  const relevant = data.data.filter((alert) => {
    if (alert.attributes.severity < 3) return false;
    const isActive = alert.attributes.active_period.some((period) => {
      const start = new Date(period.start);
      const end = period.end ? new Date(period.end) : null;
      return start <= now && (!end || end >= now);
    });
    const isUpcoming = alert.attributes.lifecycle === 'UPCOMING';
    return isActive || isUpcoming;
  });

  if (relevant.length === 0) {
    const scope = route ?? 'all subway lines';
    return `✅ ${bold('MBTA Status')}: No active alerts for ${scope}. Service is running normally.`;
  }

  const routeLabel = route ? routeDisplayName(route) : 'MBTA';
  const lines = [`🚇 ${bold(`${routeLabel} Alerts`)} (${relevant.length})`, ''];

  for (const alert of relevant.slice(0, 5)) {
    const effect = alert.attributes.effect;
    const emoji = EFFECT_EMOJI[effect] ?? '⚠️';
    lines.push(`${emoji} ${alert.attributes.header}`);
  }

  if (relevant.length > 5) {
    lines.push(`\n_...and ${relevant.length - 5} more alerts_`);
  }

  return lines.join('\n');
}

// ── Predictions (next arrivals) ──────────────────────────────────────

async function getPredictions(stop?: string, route?: string): Promise<string> {
  if (!stop) {
    return '🫘 Which station? Try: "@garbanzo next train at Park Street"';
  }

  const params: Record<string, string> = {
    'filter[stop]': stop,
    'include': 'stop,route',
    'sort': 'arrival_time',
  };

  if (route) {
    params['filter[route]'] = route;
  }

  const data = await mbtaFetch<MbtaPrediction>('/predictions', params);

  // Build a stop name lookup from included data
  const stopNames = new Map<string, string>();
  const routeNames = new Map<string, string>();

  if (data.included) {
    for (const item of data.included) {
      if ('type' in item && item.type === 'stop') {
        const s = item as unknown as MbtaStop;
        stopNames.set(s.id, s.attributes.name);
      }
      if ('type' in item && item.type === 'route') {
        const r = item as unknown as MbtaRoute;
        routeNames.set(r.id, r.attributes.long_name || r.attributes.short_name);
      }
    }
  }

  const stationName = stopNames.get(stop) ?? stop;

  // Filter to predictions with actual times
  const upcoming = data.data
    .filter((p) => p.attributes.arrival_time || p.attributes.departure_time || p.attributes.status)
    .slice(0, 8);

  if (upcoming.length === 0) {
    return `🚇 ${bold(stationName)}: No upcoming arrivals right now.`;
  }

  const lines = [`🚇 ${bold(`Next arrivals at ${stationName}`)}`, ''];

  for (const pred of upcoming) {
    const routeId = pred.relationships.route.data.id;
    const emoji = ROUTE_EMOJI[routeId] ?? '🚇';
    const time = pred.attributes.arrival_time ?? pred.attributes.departure_time;

    if (pred.attributes.status) {
      lines.push(`${emoji} ${routeId}: ${pred.attributes.status}`);
    } else if (time) {
      const minutes = minutesUntil(time);
      const label = minutes <= 0 ? 'Now' : minutes === 1 ? '1 min' : `${minutes} min`;
      lines.push(`${emoji} ${routeId}: ${bold(label)} (${formatTime(time)})`);
    }
  }

  return lines.join('\n');
}

// ── Schedule ─────────────────────────────────────────────────────────

async function getSchedule(stop?: string, route?: string): Promise<string> {
  if (!stop) {
    return '🫘 Which station? Try: "@garbanzo Red Line schedule at Harvard"';
  }

  // Get schedule for the next 2 hours
  const now = new Date();
  const minTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const later = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const maxTime = `${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`;

  const params: Record<string, string> = {
    'filter[stop]': stop,
    'filter[min_time]': minTime,
    'filter[max_time]': maxTime,
    'include': 'stop,route',
    'sort': 'departure_time',
  };

  if (route) {
    params['filter[route]'] = route;
  }

  const data = await mbtaFetch<MbtaSchedule>('/schedules', params);

  // Build name lookups
  const stopNames = new Map<string, string>();
  if (data.included) {
    for (const item of data.included) {
      if ('type' in item && item.type === 'stop') {
        const s = item as unknown as MbtaStop;
        stopNames.set(s.id, s.attributes.name);
      }
    }
  }

  const stationName = stopNames.get(stop) ?? stop;
  const schedules = data.data.slice(0, 10);

  if (schedules.length === 0) {
    return `🚇 ${bold(stationName)}: No scheduled service in the next 2 hours.`;
  }

  const lines = [`🚇 ${bold(`Schedule at ${stationName}`)} (next 2 hours)`, ''];

  for (const sched of schedules) {
    const routeId = sched.relationships.route.data.id;
    const emoji = ROUTE_EMOJI[routeId] ?? '🚇';
    const time = sched.attributes.departure_time ?? sched.attributes.arrival_time;
    if (time) {
      lines.push(`${emoji} ${routeId}: ${formatTime(time)}`);
    }
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────

function minutesUntil(isoTime: string): number {
  const target = new Date(isoTime);
  const now = new Date();
  return Math.round((target.getTime() - now.getTime()) / 60000);
}

function formatTime(isoTime: string): string {
  const date = new Date(isoTime);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  });
}

function routeDisplayName(route: string): string {
  if (route.includes(',')) return 'Green Line';
  return route.replace('-', ' ');
}
