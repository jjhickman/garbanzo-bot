import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

import { logger } from '../middleware/logger.js';
import { homePath } from '../utils/paths.js';

const BRIDGE_MAP_PATH = homePath('config/bridge-map.json');

const BridgeEndpointSchema = z.object({
  instance: z.string().min(1),
  chatId: z.string().min(1),
});

const BridgeRouteSchema = z.object({
  id: z.string().min(1),
  endpoints: z.array(BridgeEndpointSchema).min(2),
  direction: z.enum(['both', 'one-way']),
  from: z.string().min(1).optional(),
  modeToWhatsApp: z.enum(['summary', 'verbatim']).default('summary'),
  modeToDiscord: z.enum(['verbatim', 'summary']).default('verbatim'),
  relayCommands: z.boolean().default(false),
  ingestRelayed: z.boolean().default(false),
});

export const BridgeMapSchema = z.object({
  instances: z.array(z.object({
    id: z.string().min(1),
    platform: z.enum(['whatsapp', 'discord', 'slack', 'telegram', 'matrix']),
    url: z.string().url().optional(),
  })),
  routes: z.array(BridgeRouteSchema),
}).superRefine((map, ctx) => {
  const instanceIds = new Set<string>();
  for (const [index, instance] of map.instances.entries()) {
    if (instanceIds.has(instance.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instances', index, 'id'],
        message: `Duplicate instance id: ${instance.id}`,
      });
    }
    instanceIds.add(instance.id);
  }

  const routeIds = new Set<string>();
  for (const [index, route] of map.routes.entries()) {
    if (routeIds.has(route.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routes', index, 'id'],
        message: `Duplicate route id: ${route.id}`,
      });
    }
    routeIds.add(route.id);

    const endpointKeys = new Set<string>();
    for (const [endpointIndex, endpoint] of route.endpoints.entries()) {
      if (!instanceIds.has(endpoint.instance)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routes', index, 'endpoints', endpointIndex, 'instance'],
          message: `Unknown bridge instance: ${endpoint.instance}`,
        });
      }

      const endpointKey = `${endpoint.instance}\0${endpoint.chatId}`;
      if (endpointKeys.has(endpointKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routes', index, 'endpoints', endpointIndex],
          message: 'Bridge route endpoints must differ by instance and chatId',
        });
      }
      endpointKeys.add(endpointKey);
    }

    if (route.direction === 'one-way') {
      if (route.from === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routes', index, 'from'],
          message: 'One-way bridge routes require from',
        });
      } else if (!route.endpoints.some((endpoint) => endpoint.instance === route.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routes', index, 'from'],
          message: 'One-way bridge from must be one endpoint instance',
        });
      }
    }
  }
});

export type BridgeMap = z.infer<typeof BridgeMapSchema>;
export type BridgeRoute = BridgeMap['routes'][number];

let loadedBridgeMap: BridgeMap | null | undefined;

function expandEnvPlaceholder(match: string, name: string, defaultValue: string | undefined): string {
  const envValue = process.env[name];
  if (envValue !== undefined && envValue !== '') return envValue;
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`Missing environment variable ${name} for bridge map placeholder ${match}`);
}

export function expandBridgeMapEnvPlaceholders(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      expandEnvPlaceholder,
    );
  }

  if (Array.isArray(value)) {
    return value.map((entry) => expandBridgeMapEnvPlaceholders(entry));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandBridgeMapEnvPlaceholders(entry)]),
    );
  }

  return value;
}

/**
 * Build a human-readable description of a single zod issue against the
 * bridge map, naming the offending instance/route entry by its declared id
 * when available (falling back to its array index) rather than just the
 * raw zod path — so an operator staring at a startup log can tell which
 * entry in bridge-map.json to fix without cross-referencing indices by hand.
 */
function describeBridgeMapIssue(issue: z.ZodIssue, raw: unknown): string {
  const [section, entryIndex, ...rest] = issue.path;
  const isEntryPath = (section === 'instances' || section === 'routes') && typeof entryIndex === 'number';

  if (!isEntryPath) {
    return `${issue.path.join('.') || '<root>'}: ${issue.message}`;
  }

  const collection = (raw as Record<string, unknown> | null | undefined)?.[section as string];
  const entry = Array.isArray(collection) ? (collection[entryIndex] as Record<string, unknown> | undefined) : undefined;
  const entryLabel = typeof entry?.id === 'string' && entry.id.length > 0
    ? `id "${entry.id}"`
    : `index ${entryIndex}`;
  const field = rest.length > 0 ? ` field ${rest.join('.')}` : '';

  return `${section} entry (${entryLabel})${field}: ${issue.message}`;
}

/** Exported for tests asserting the bridge-map loader names the offending entry. */
export function formatBridgeMapZodError(error: z.ZodError, raw: unknown): string {
  const details = error.issues.map((issue) => describeBridgeMapIssue(issue, raw)).join('; ');
  return `Invalid bridge map config: ${details}`;
}

export function loadBridgeMap(): BridgeMap | null {
  if (loadedBridgeMap !== undefined) return loadedBridgeMap;

  if (!existsSync(BRIDGE_MAP_PATH)) {
    logger.warn({ path: BRIDGE_MAP_PATH }, 'Bridge map config file not found; bridge routes disabled');
    loadedBridgeMap = null;
    return loadedBridgeMap;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(BRIDGE_MAP_PATH, 'utf8')) as unknown;
    raw = expandBridgeMapEnvPlaceholders(raw);
    loadedBridgeMap = BridgeMapSchema.parse(raw);
    return loadedBridgeMap;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const message = formatBridgeMapZodError(err, raw);
      logger.warn({ issues: err.issues, path: BRIDGE_MAP_PATH }, message);
    } else {
      logger.warn({ err, path: BRIDGE_MAP_PATH }, 'Failed to load bridge map config; bridge routes disabled');
    }
    loadedBridgeMap = null;
    return loadedBridgeMap;
  }
}

function canSendFrom(route: BridgeRoute, instanceId: string): boolean {
  return route.direction === 'both' || route.from === instanceId;
}

export function allRoutesForInstance(map: BridgeMap, instanceId: string): BridgeRoute[] {
  return map.routes.filter((route) =>
    route.endpoints.some((endpoint) => endpoint.instance === instanceId));
}

export function outboundRoutesForInstance(map: BridgeMap, instanceId: string): BridgeRoute[] {
  return allRoutesForInstance(map, instanceId).filter((route) => canSendFrom(route, instanceId));
}

export function findOutboundRoute(
  map: BridgeMap,
  instanceId: string,
  chatId: string,
): BridgeRoute | undefined {
  return outboundRoutesForInstance(map, instanceId).find((route) =>
    route.endpoints.some((endpoint) => endpoint.instance === instanceId && endpoint.chatId === chatId));
}
