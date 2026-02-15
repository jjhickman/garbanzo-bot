import { logger } from '../../middleware/logger.js';
import type { PlatformRuntime } from '../types.js';

export function createDiscordRuntime(): PlatformRuntime {
  return {
    platform: 'discord',
    async start(): Promise<void> {
      logger.fatal({ platform: 'discord' }, 'Discord runtime is not implemented yet');
      throw new Error('Discord runtime is not implemented');
    },
  };
}
