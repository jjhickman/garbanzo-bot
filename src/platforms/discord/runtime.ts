import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import type { PlatformRuntime } from '../types.js';

import { createDiscordDemoServer } from './demo-server.js';
import { createDiscordInteractionsServer } from './gateway-runtime.js';

export function createDiscordRuntime(): PlatformRuntime {
  return {
    platform: 'discord',
    async start(): Promise<void> {
      if (config.DISCORD_BOT_TOKEN && config.DISCORD_PUBLIC_KEY) {
        createDiscordInteractionsServer({
          host: config.DISCORD_INTERACTIONS_BIND_HOST,
          port: config.DISCORD_INTERACTIONS_PORT,
          botToken: config.DISCORD_BOT_TOKEN,
          publicKey: config.DISCORD_PUBLIC_KEY,
          ownerId: config.OWNER_JID,
        });

        logger.info(
          { host: config.DISCORD_INTERACTIONS_BIND_HOST, port: config.DISCORD_INTERACTIONS_PORT },
          'Discord official runtime started',
        );
        return;
      }

      if (config.DISCORD_DEMO) {
        createDiscordDemoServer({
          host: config.DISCORD_DEMO_BIND_HOST,
          port: config.DISCORD_DEMO_PORT,
        });

        logger.info(
          { host: config.DISCORD_DEMO_BIND_HOST, port: config.DISCORD_DEMO_PORT },
          'Discord demo mode started (local dev only)',
        );
        return;
      }

      logger.fatal(
        { platform: 'discord' },
        'Discord runtime requires DISCORD_BOT_TOKEN + DISCORD_PUBLIC_KEY, or DISCORD_DEMO=true for local demo mode',
      );
      throw new Error('Discord runtime is not configured');
    },
  };
}
