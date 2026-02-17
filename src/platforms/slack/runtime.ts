import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import type { PlatformRuntime } from '../types.js';

import { createSlackDemoServer } from './demo-server.js';
import { createSlackEventsServer } from './events-server.js';
import { createSlackTokenProvider } from './token-manager.js';

export function createSlackRuntime(): PlatformRuntime {
  return {
    platform: 'slack',
    async start(): Promise<void> {
      if (config.SLACK_BOT_TOKEN && config.SLACK_SIGNING_SECRET) {
        const tokenProvider = createSlackTokenProvider({
          accessToken: config.SLACK_BOT_TOKEN,
          refreshToken: config.SLACK_REFRESH_TOKEN,
          clientId: config.SLACK_CLIENT_ID,
          clientSecret: config.SLACK_CLIENT_SECRET,
          stateFile: config.SLACK_TOKEN_STATE_FILE,
          minBufferMinutes: config.SLACK_TOKEN_ROTATE_MIN_BUFFER,
        });

        createSlackEventsServer({
          host: config.SLACK_EVENTS_BIND_HOST,
          port: config.SLACK_EVENTS_PORT,
          tokenProvider,
          signingSecret: config.SLACK_SIGNING_SECRET,
          ownerId: config.OWNER_JID,
          botUserId: config.SLACK_BOT_USER_ID,
        });

        logger.info(
          {
            host: config.SLACK_EVENTS_BIND_HOST,
            port: config.SLACK_EVENTS_PORT,
            tokenRotationEnabled: Boolean(
              config.SLACK_CLIENT_ID
              && config.SLACK_CLIENT_SECRET
              && config.SLACK_REFRESH_TOKEN,
            ),
          },
          'Slack official runtime started',
        );
        return;
      }

      if (config.SLACK_DEMO) {
        createSlackDemoServer({
          host: config.SLACK_DEMO_BIND_HOST,
          port: config.SLACK_DEMO_PORT,
        });

        logger.info(
          { host: config.SLACK_DEMO_BIND_HOST, port: config.SLACK_DEMO_PORT },
          'Slack demo mode started (local dev only)',
        );
        return;
      }

      logger.fatal(
        { platform: 'slack' },
        'Slack runtime requires SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET, or SLACK_DEMO=true for local demo mode',
      );
      throw new Error('Slack runtime is not configured');
    },
  };
}
