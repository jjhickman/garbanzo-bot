import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import { logger } from '../middleware/logger.js';
import { PROJECT_ROOT } from '../utils/config.js';

const BRIDGE_MAP_PATH = resolve(PROJECT_ROOT, 'config/bridge-map.json');

const BridgeEndpointSchema = z.object({
  instance: z.string().min(1),
  chatId: z.string().min(1),
});

const BridgeRouteSchema = z.object({
  id: z.string().min(1),
  endpoints: z.tuple([BridgeEndpointSchema, BridgeEndpointSchema]),
  direction: z.enum(['both', 'one-way']),
  from: z.string().min(1).optional(),
  modeToWhatsApp: z.enum(['summary', 'verbatim']).default('summary'),
  modeToDiscord: z.enum(['verbatim', 'summary']).default('verbatim'),
  relayCommands: z.boolean().default(false),
});

export const BridgeMapSchema = z.object({
  instances: z.array(z.object({
    id: z.string().min(1),
    platform: z.enum(['whatsapp', 'discord', 'slack', 'teams']),
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

    const [first, second] = route.endpoints;
    for (const [endpointIndex, endpoint] of route.endpoints.entries()) {
      if (!instanceIds.has(endpoint.instance)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routes', index, 'endpoints', endpointIndex, 'instance'],
          message: `Unknown bridge instance: ${endpoint.instance}`,
        });
      }
    }

    if (first.instance === second.instance && first.chatId === second.chatId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routes', index, 'endpoints'],
        message: 'Bridge route endpoints must differ',
      });
    }

    if (route.direction === 'one-way') {
      if (route.from === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routes', index, 'from'],
          message: 'One-way bridge routes require from',
        });
      } else if (route.from !== first.instance && route.from !== second.instance) {
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

export function loadBridgeMap(): BridgeMap | null {
  if (loadedBridgeMap !== undefined) return loadedBridgeMap;

  if (!existsSync(BRIDGE_MAP_PATH)) {
    logger.warn({ path: BRIDGE_MAP_PATH }, 'Bridge map config file not found; bridge routes disabled');
    loadedBridgeMap = null;
    return loadedBridgeMap;
  }

  try {
    const raw = JSON.parse(readFileSync(BRIDGE_MAP_PATH, 'utf8')) as unknown;
    loadedBridgeMap = BridgeMapSchema.parse(raw);
    return loadedBridgeMap;
  } catch (err) {
    logger.warn({ err, path: BRIDGE_MAP_PATH }, 'Failed to load bridge map config; bridge routes disabled');
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
