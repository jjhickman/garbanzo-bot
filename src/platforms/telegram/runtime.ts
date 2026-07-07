import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';
import type { PlatformRuntime } from '../types.js';

import { createTelegramAdapter } from './adapter.js';
import { createTelegramClient } from './client.js';
import { getTelegramOwnerId } from './telegram-config.js';
import { resolveOwnerChatId } from './telegram-owner.js';

export interface TelegramRuntimeDeps {
  createAdapter?: typeof createTelegramAdapter;
  createClient?: typeof createTelegramClient;
  getOwnerId?: typeof getTelegramOwnerId;
  resolveOwnerChatId?: typeof resolveOwnerChatId;
}

type TelegramClient = ReturnType<typeof createTelegramClient>;

// Health/staleness reporting: Discord's runtime does not feed connection
// state into src/middleware/health.ts at all (markConnected/markDisconnected
// are wired only from the WhatsApp connection module) — "consistent with
// discord's runtime" means matching that absence rather than inventing new
// wiring here. If a future task wants Telegram connection state on
// /health, it should extend health.ts for every platform at once rather
// than have Telegram alone poke at WhatsApp-shaped globals.
export function createTelegramRuntime(deps: TelegramRuntimeDeps = {}): PlatformRuntime {
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
