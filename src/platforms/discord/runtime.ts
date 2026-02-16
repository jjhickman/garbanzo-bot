import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import type { PlatformRuntime } from '../types.js';

import { createDiscordDemoServer } from './demo-server.js';

export function createDiscordRuntime(): PlatformRuntime {
  return {
    platform: 'discord',
    async start(): Promise<void> {
      if (!config.DISCORD_DEMO) {
        logger.fatal(
          { platform: 'discord' },
          'Discord runtime is not implemented (set MESSAGING_PLATFORM=whatsapp, or DISCORD_DEMO=true for local demo mode)',
        );
        throw new Error('Discord runtime is not implemented');
      }

      createDiscordDemoServer({
        host: config.DISCORD_DEMO_BIND_HOST,
        port: config.DISCORD_DEMO_PORT,
      });

      logger.info(
        { host: config.DISCORD_DEMO_BIND_HOST, port: config.DISCORD_DEMO_PORT },
        'Discord demo mode started (local dev only)',
      );
    },
  };
}
