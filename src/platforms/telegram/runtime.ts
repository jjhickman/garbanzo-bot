import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';
import type { PlatformRuntime } from '../types.js';
import { registerChatNameResolver } from '../../core/groups-config.js';

import { createTelegramAdapter } from './adapter.js';
import { createTelegramClient } from './client.js';
import { getTelegramChatName, getTelegramOwnerId } from './telegram-config.js';
import { resolveOwnerChatId } from './telegram-owner.js';

export interface TelegramRuntimeDeps {
  createAdapter?: typeof createTelegramAdapter;
  createClient?: typeof createTelegramClient;
  getOwnerId?: typeof getTelegramOwnerId;
  resolveOwnerChatId?: typeof resolveOwnerChatId;
}

type TelegramClient = ReturnType<typeof createTelegramClient>;

// Health/staleness reporting (T2 review, F4): this WAS a deliberate absence
// matching Discord's runtime (which still does not feed connection state
// into src/middleware/health.ts). That absence left /health/ready
// permanently 503 for Telegram even when long-polling was healthy — a
// worse outcome than the inconsistency. client.ts now calls
// markConnected()/markDisconnected() directly (successful poll start /
// poll loop death or stop), so Telegram intentionally reports where
// Discord still doesn't. Discord's absence is a separate, untouched
// decision — see this file's own history, not a signal to copy here.
export function createTelegramRuntime(deps: TelegramRuntimeDeps = {}): PlatformRuntime {
  // Digest/recap chat names resolve through core; register this platform's
  // resolver so Telegram chats don't render as 'Unknown Group'.
  registerChatNameResolver(getTelegramChatName);
  const runtimeDeps = {
    createAdapter: deps.createAdapter ?? createTelegramAdapter,
    createClient: deps.createClient ?? createTelegramClient,
    getOwnerId: deps.getOwnerId ?? getTelegramOwnerId,
    resolveOwnerChatId: deps.resolveOwnerChatId ?? resolveOwnerChatId,
  };

  let client: TelegramClient | null = null;
  let currentMessenger: PlatformMessenger | null = null;

  return {
    platform: 'telegram',

    async start(): Promise<void> {
      const token = config.TELEGRAM_BOT_TOKEN;
      const ownerUserId = runtimeDeps.getOwnerId();

      if (!token || !ownerUserId) {
        logger.fatal(
          { platform: 'telegram' },
          'Telegram runtime requires TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID',
        );
        throw new Error('Telegram runtime requires TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID');
      }

      const adapter = runtimeDeps.createAdapter(token);
      currentMessenger = adapter;

      // Best-effort owner chat resolution (mirrors discord-owner.ts's
      // resolve-and-DM shape) — falls back to the raw configured id when
      // Telegram can't confirm it yet (e.g. the owner hasn't started a chat
      // with the bot). Never blocks startup.
      const ownerChatId = await runtimeDeps.resolveOwnerChatId(token, ownerUserId) ?? ownerUserId;

      const telegramClient = runtimeDeps.createClient({
        token,
        ownerId: ownerChatId,
        ownerUserId,
      });

      client = telegramClient;
      await telegramClient.start();

      logger.info({ ownerUserId, ownerChatId }, 'Telegram long-poll runtime started');
    },

    async stop(): Promise<void> {
      const current = client;
      client = null;
      currentMessenger = null;
      if (current) {
        await current.stop();
      }
    },

    getMessenger(): PlatformMessenger | null {
      return currentMessenger;
    },
  };
}
