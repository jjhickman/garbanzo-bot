import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import { homePath } from '../../utils/paths.js';

const MatrixRoomConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  requireMention: z.boolean().default(true),
  alias: z.string().optional(),
  enabledFeatures: z.array(z.string()).optional(),
  persona: z.string().optional(),
});

export const MatrixRoomsConfigSchema = z.object({
  ownerId: z.string().optional(),
  rooms: z.record(z.string(), MatrixRoomConfigSchema),
});

type MatrixRoomsConfig = z.infer<typeof MatrixRoomsConfigSchema>;

const DEFAULT_MATRIX_ROOMS_CONFIG: MatrixRoomsConfig = {
  rooms: {},
};

function resolveMatrixConfigPath(path: string): string {
  return isAbsolute(path) ? path : homePath(path);
}

function loadMatrixRoomsConfig(): MatrixRoomsConfig {
  const path = resolveMatrixConfigPath(config.MATRIX_ROOMS_CONFIG_PATH);

  if (!existsSync(path)) {
    logger.warn({ path }, 'Matrix rooms config file not found; all rooms disabled by default');
    return DEFAULT_MATRIX_ROOMS_CONFIG;
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return MatrixRoomsConfigSchema.parse(raw);
  } catch (err) {
    logger.warn({ err, path }, 'Failed to load Matrix rooms config; all rooms disabled by default');
    return DEFAULT_MATRIX_ROOMS_CONFIG;
  }
}

const matrixRoomsConfig = loadMatrixRoomsConfig();

export function getMatrixOwnerId(): string | undefined {
  return config.MATRIX_OWNER_ID ?? matrixRoomsConfig.ownerId;
}

export function isMatrixRoomEnabled(roomId: string): boolean {
  return matrixRoomsConfig.rooms[roomId]?.enabled ?? false;
}

export function matrixRoomRequiresMention(roomId: string): boolean {
  return matrixRoomsConfig.rooms[roomId]?.requireMention ?? true;
}

export function isMatrixFeatureEnabled(roomId: string, feature: string): boolean {
  const room = matrixRoomsConfig.rooms[roomId];
  if (!room || !room.enabled) return false;
  if (room.enabledFeatures === undefined) return true;
  return room.enabledFeatures.includes(feature);
}

export function getMatrixRoomName(roomId: string): string | undefined {
  return matrixRoomsConfig.rooms[roomId]?.name;
}

export function getMatrixRoomPersona(roomId: string): string | undefined {
  return matrixRoomsConfig.rooms[roomId]?.persona;
}
