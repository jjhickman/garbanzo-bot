import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

import { logger } from '../middleware/logger.js';
import { homePath } from '../utils/paths.js';
import {
  BridgeMapSchema,
  expandBridgeMapEnvPlaceholders,
  formatBridgeMapZodError,
  type BridgeMap,
  type BridgeRoute,
} from './bridge-map-schema.js';

export {
  BridgeMapSchema,
  describeBridgeMapIssue,
  expandBridgeMapEnvPlaceholders,
  formatBridgeMapZodError,
} from './bridge-map-schema.js';
export type { BridgeMap, BridgeRoute } from './bridge-map-schema.js';

const BRIDGE_MAP_PATH = homePath('config/bridge-map.json');

let loadedBridgeMap: BridgeMap | null | undefined;

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
