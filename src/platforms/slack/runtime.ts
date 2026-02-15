import { logger } from '../../middleware/logger.js';
import type { PlatformRuntime } from '../types.js';

export function createSlackRuntime(): PlatformRuntime {
  return {
    platform: 'slack',
    async start(): Promise<void> {
      logger.fatal({ platform: 'slack' }, 'Slack runtime is not implemented yet');
      throw new Error('Slack runtime is not implemented');
    },
  };
}
