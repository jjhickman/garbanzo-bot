import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import type { PlatformRuntime } from '../types.js';

import { createSlackDemoServer } from './demo-server.js';

export function createSlackRuntime(): PlatformRuntime {
  return {
    platform: 'slack',
    async start(): Promise<void> {
      if (!config.SLACK_DEMO) {
        logger.fatal(
          { platform: 'slack' },
          'Slack runtime is not implemented (set MESSAGING_PLATFORM=whatsapp, or SLACK_DEMO=true for local demo mode)',
        );
        throw new Error('Slack runtime is not implemented');
      }

      createSlackDemoServer({
        host: config.SLACK_DEMO_BIND_HOST,
        port: config.SLACK_DEMO_PORT,
      });

      logger.info(
        { host: config.SLACK_DEMO_BIND_HOST, port: config.SLACK_DEMO_PORT },
        'Slack demo mode started (local dev only)',
      );
    },
  };
}
