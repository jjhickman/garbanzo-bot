import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import { homePath } from '../../utils/paths.js';

// Mirrors discord-config.ts's fail-soft pattern exactly. Field naming
// intentionally differs from Discord's "features" key (this schema uses
// "enabledFeatures") and adds a per-chat "persona" override slot — both per
// the WS1 plan. Shape otherwise matches discord-channels.json so the core
// gating helpers (isGroupEnabled / requireMention / feature predicate) are a
// 1:1 reuse, not a fork.
const TelegramChatConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  // Privacy mode ON (BotFather default) already limits the bot to seeing
  // commands/mentions/replies — requireMention:true is the matching,
  // recommended default. Disabling privacy mode via BotFather is what makes
  // requireMention:false meaningful (the bot then sees every message in the
  // group). See processor.ts for how both modes are handled on the inbound
  // path.
  requireMention: z.boolean().default(true),
  enabledFeatures: z.array(z.string()).optional(),
  // Reserved for a future per-chat persona override (not wired yet in T2 —
  // core persona selection is platform-keyed, not chat-keyed today).
  persona: z.string().optional(),
});

const TelegramChatsConfigSchema = z.object({
  ownerId: z.string().optional(),
  chats: z.record(z.string(), TelegramChatConfigSchema),
});

type TelegramChatsConfig = z.infer<typeof TelegramChatsConfigSchema>;

const DEFAULT_TELEGRAM_CHATS_CONFIG: TelegramChatsConfig = {
  chats: {},
};

function resolveTelegramConfigPath(path: string): string {
  return isAbsolute(path) ? path : homePath(path);
}

function loadTelegramChatsConfig(): TelegramChatsConfig {
  const path = resolveTelegramConfigPath(config.TELEGRAM_CHATS_CONFIG_PATH);

  if (!existsSync(path)) {
    logger.warn({ path }, 'Telegram chats config file not found; all chats disabled by default');
    return DEFAULT_TELEGRAM_CHATS_CONFIG;
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return TelegramChatsConfigSchema.parse(raw);
  } catch (err) {
    logger.warn({ err, path }, 'Failed to load Telegram chats config; all chats disabled by default');
    return DEFAULT_TELEGRAM_CHATS_CONFIG;
  }
}

const telegramChatsConfig = loadTelegramChatsConfig();

export function getTelegramOwnerId(): string | undefined {
  return config.TELEGRAM_OWNER_ID ?? telegramChatsConfig.ownerId;
}

export function isTelegramChatEnabled(chatId: string): boolean {
  return telegramChatsConfig.chats[chatId]?.enabled ?? false;
}

export function telegramChatRequiresMention(chatId: string): boolean {
  return telegramChatsConfig.chats[chatId]?.requireMention ?? true;
}

export function isTelegramFeatureEnabled(chatId: string, feature: string): boolean {
  const chat = telegramChatsConfig.chats[chatId];
  if (!chat || !chat.enabled) return false;
  if (chat.enabledFeatures === undefined) return true;
  return chat.enabledFeatures.includes(feature);
}

export function getTelegramChatName(chatId: string): string | undefined {
  return telegramChatsConfig.chats[chatId]?.name;
}

export function getTelegramChatPersona(chatId: string): string | undefined {
  return telegramChatsConfig.chats[chatId]?.persona;
}
