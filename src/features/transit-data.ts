/**
 * MBTA Transit static data — types, station/route aliases, and emoji maps.
 *
 * Extracted from transit.ts for maintainability. Pure data, no logic.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface MbtaPrediction {
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

export interface MbtaAlert {
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

export interface MbtaSchedule {
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

export interface MbtaStop {
  id: string;
  attributes: { name: string };
}

export interface MbtaRoute {
  id: string;
  attributes: {
    long_name: string;
    short_name: string;
    direction_names: string[];
    color: string;
  };
}

export interface JsonApiResponse<T> {
  data: T[];
  included?: Array<MbtaStop | MbtaRoute | Record<string, unknown>>;
}

// ── Known stations & routes ──────────────────────────────────────────

export const ROUTE_ALIASES: Record<string, string> = {
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

export const STATION_ALIASES: Record<string, string> = {
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

export const ROUTE_EMOJI: Record<string, string> = {
  'Red': '🔴',
  'Orange': '🟠',
  'Blue': '🔵',
  'Green-B': '🟢',
  'Green-C': '🟢',
  'Green-D': '🟢',
  'Green-E': '🟢',
  'Mattapan': '🔴',
};

export const EFFECT_EMOJI: Record<string, string> = {
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
