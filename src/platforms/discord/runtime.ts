import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import type { PlatformRuntime } from '../types.js';

import { createDiscordAdapter } from './adapter.js';
import { createDiscordDemoServer } from './demo-server.js';
import { getDiscordOwnerId } from './discord-config.js';
import { resolveOwnerDmChannelId } from './discord-owner.js';
import { createDiscordGatewayClient } from './gateway-client.js';
import { createDiscordInteractionsServer } from './gateway-runtime.js';
import {
  scheduleDiscordDigest,
  scheduleDiscordEventReminders,
  scheduleDiscordPracticeAgenda,
  scheduleDiscordRehearsalReminders,
  scheduleDiscordWeeklyRecap,
} from './schedulers.js';

export interface DiscordRuntimeDeps {
  createAdapter?: typeof createDiscordAdapter;
  createDemoServer?: typeof createDiscordDemoServer;
  createGatewayClient?: typeof createDiscordGatewayClient;
  createInteractionsServer?: typeof createDiscordInteractionsServer;
  getOwnerId?: typeof getDiscordOwnerId;
  resolveOwnerDmChannelId?: typeof resolveOwnerDmChannelId;
  scheduleDigest?: typeof scheduleDiscordDigest;
  scheduleEventReminders?: typeof scheduleDiscordEventReminders;
  schedulePracticeAgenda?: typeof scheduleDiscordPracticeAgenda;
  scheduleRehearsalReminders?: typeof scheduleDiscordRehearsalReminders;
  scheduleWeeklyRecap?: typeof scheduleDiscordWeeklyRecap;
}

type DiscordGatewayRuntimeClient = ReturnType<typeof createDiscordGatewayClient>;

export function createDiscordRuntime(deps: DiscordRuntimeDeps = {}): PlatformRuntime {
  const runtimeDeps = {
    createAdapter: deps.createAdapter ?? createDiscordAdapter,
    createDemoServer: deps.createDemoServer ?? createDiscordDemoServer,
    createGatewayClient: deps.createGatewayClient ?? createDiscordGatewayClient,
    createInteractionsServer: deps.createInteractionsServer ?? createDiscordInteractionsServer,
    getOwnerId: deps.getOwnerId ?? getDiscordOwnerId,
    resolveOwnerDmChannelId: deps.resolveOwnerDmChannelId ?? resolveOwnerDmChannelId,
    scheduleDigest: deps.scheduleDigest ?? scheduleDiscordDigest,
    scheduleEventReminders: deps.scheduleEventReminders ?? scheduleDiscordEventReminders,
    schedulePracticeAgenda: deps.schedulePracticeAgenda ?? scheduleDiscordPracticeAgenda,
    scheduleRehearsalReminders: deps.scheduleRehearsalReminders ?? scheduleDiscordRehearsalReminders,
    scheduleWeeklyRecap: deps.scheduleWeeklyRecap ?? scheduleDiscordWeeklyRecap,
  };
  let gatewayClient: DiscordGatewayRuntimeClient | null = null;
  const disposers: Array<() => void> = [];

  function disposeAll(): void {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        logger.warn({ err }, 'Discord scheduler dispose failed');
      }
    }
  }

  return {
    platform: 'discord',
    async start(): Promise<void> {
      const token = config.DISCORD_BOT_TOKEN;

      if (token && config.DISCORD_GATEWAY_ENABLED) {
        const adapter = runtimeDeps.createAdapter(token);
        const ownerUserId = runtimeDeps.getOwnerId();

        if (!ownerUserId) {
          logger.fatal(
            { platform: 'discord' },
            'Discord Gateway runtime requires DISCORD_OWNER_ID',
          );
          throw new Error('Discord runtime requires DISCORD_OWNER_ID');
        }

        const ownerDmChannelId = await runtimeDeps.resolveOwnerDmChannelId(token, ownerUserId) ?? ownerUserId;
        const client = runtimeDeps.createGatewayClient({
          token,
          ownerId: ownerDmChannelId,
          ownerUserId,
        });

        gatewayClient = client;
        await client.start();

        disposers.push(runtimeDeps.scheduleDigest(
          adapter,
          config.DISCORD_DIGEST_CHANNEL_ID ?? ownerDmChannelId,
        ));
        if (config.WEEKLY_RECAP_ENABLED) {
          disposers.push(runtimeDeps.scheduleWeeklyRecap(
            adapter,
            config.DISCORD_RECAP_CHANNEL_ID ?? ownerDmChannelId,
          ));
        }
        disposers.push(runtimeDeps.scheduleEventReminders(adapter));

        const practiceChannelId = config.DISCORD_PRACTICE_CHANNEL_ID ?? ownerDmChannelId;
        disposers.push(runtimeDeps.scheduleRehearsalReminders(adapter, practiceChannelId));
        disposers.push(runtimeDeps.schedulePracticeAgenda(adapter, practiceChannelId));

        logger.info({ ownerUserId, ownerDmChannelId }, 'Discord Gateway runtime started');
        return;
      }

      if (config.DISCORD_GATEWAY_ENABLED === false && token && config.DISCORD_PUBLIC_KEY) {
        runtimeDeps.createInteractionsServer({
          host: config.DISCORD_INTERACTIONS_BIND_HOST,
          port: config.DISCORD_INTERACTIONS_PORT,
          botToken: token,
          publicKey: config.DISCORD_PUBLIC_KEY,
          ownerId: config.OWNER_JID ?? runtimeDeps.getOwnerId() ?? '',
        });

        logger.info(
          { host: config.DISCORD_INTERACTIONS_BIND_HOST, port: config.DISCORD_INTERACTIONS_PORT },
          'Discord official runtime started',
        );
        return;
      }

      if (config.DISCORD_DEMO) {
        runtimeDeps.createDemoServer({
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
        'Discord runtime requires DISCORD_BOT_TOKEN + DISCORD_OWNER_ID for Gateway, DISCORD_GATEWAY_ENABLED=false + DISCORD_PUBLIC_KEY for interactions, or DISCORD_DEMO=true for local demo mode',
      );
      throw new Error('Discord runtime is not configured');
    },
    async stop(): Promise<void> {
      disposeAll();
      const client = gatewayClient;
      gatewayClient = null;
      if (client) {
        await client.stop();
      }
    },
  };
}
