import { logger } from '../../middleware/logger.js';
import type { PlatformRuntime } from '../types.js';

export function createTeamsRuntime(): PlatformRuntime {
  return {
    platform: 'teams',
    async start(): Promise<void> {
      logger.fatal({ platform: 'teams' }, 'Teams runtime is not implemented yet');
      throw new Error('Teams runtime is not implemented');
    },
    async stop(): Promise<void> {
      // No persistent resources to release here yet; present for lifecycle parity.
    },
  };
}
