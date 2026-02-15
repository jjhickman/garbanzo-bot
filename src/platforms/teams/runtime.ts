import { logger } from '../../middleware/logger.js';
import type { PlatformRuntime } from '../types.js';

export function createTeamsRuntime(): PlatformRuntime {
  return {
    platform: 'teams',
    async start(): Promise<void> {
      logger.fatal({ platform: 'teams' }, 'Teams runtime is not implemented yet');
      throw new Error('Teams runtime is not implemented');
    },
  };
}
