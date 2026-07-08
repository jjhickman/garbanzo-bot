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
  // PRIVACY MODE — corrected premise (T2 review, F2): Telegram's group
  // "privacy mode" (BotFather default: ON) does NOT merely "limit the bot
  // to commands/mentions/replies" — in privacy-ON groups the bot NEVER
  // receives plain text at all, including plain @username mentions and our
  // `!command` convention (those are ordinary text messages to Telegram).
  // Privacy-ON only forwards native `/command` messages, direct replies to
  // one of the bot's own messages, and via-bot messages. Since this
  // processor understands `!command` and literal "@username" text, neither
  // of which privacy-ON ever delivers, a requireMention:true chat under
  // privacy-ON is effectively REPLY-ONLY, and requireMention:false chats
  // receive nothing.
  //
  // RECOMMENDED setup: disable privacy mode via BotFather (`/setprivacy` ->
  // Disable) so the bot sees every message, and keep requireMention:true
  // here so it only RESPONDS to @mentions/replies/!commands — this is the
  // same shape as Discord's MessageContent intent + requireMention:true
  // (Telegram seeing everything is not the same as the bot acting on
  // everything). Privacy-ON is a valid, degraded, commands-and-replies-only
  // fallback for operators who don't want to touch BotFather settings — not
  // the recommended default. See processor.ts for how both modes are
  // handled on the inbound path.
  requireMention: z.boolean().default(true),
  enabledFeatures: z.array(z.string()).optional(),
  // Reserved for a future per-chat persona override (not wired yet in T2 —
  // core persona selection is platform-keyed, not chat-keyed today).
  persona: z.string().optional(),
});

// Exported (F10, T2 review) so tests can validate config/telegram-chats.example.json
// against the exact schema the loader uses, mirroring the bridge-map/rag-sources example tests.
export const TelegramChatsConfigSchema = z.object({
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
