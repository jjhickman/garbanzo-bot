import { z } from 'zod';
import { optionalString } from './shared.js';

export const telegramSchema = z.object({
  // Telegram runtime (long polling only — see docs/_internal/plans for the
  // webhook-mode non-goal). TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_ID are
  // required iff MESSAGING_PLATFORM=telegram; enforced in
  // src/utils/config/index.ts, mirroring the WhatsApp OWNER_JID check.
  TELEGRAM_BOT_TOKEN: optionalString,
  // A Telegram user id (numeric). Validated as digits-only in index.ts
  // regardless of platform, since a malformed value is never useful.
  TELEGRAM_OWNER_ID: optionalString,
  TELEGRAM_CHATS_CONFIG_PATH: z.string().default('config/telegram-chats.json'),
  // F6 (T2 review): mirrors WHATSAPP_CHAT_SCOPE's shape, but the DEFAULT is
  // deliberately 'configured' rather than WhatsApp's 'all' — a WhatsApp
  // number only joins groups the operator explicitly adds it to, but
  // ANYONE can add this bot to ANY Telegram group via its @username, so
  // ingesting (recording/moderating/bridge-capturing) unconfigured groups
  // by default is unsafe here in a way it isn't for WhatsApp. DMs are never
  // gated by this — see process-inbound-message.ts's shouldIngestGroupChat
  // hook, which only applies to group chats.
  TELEGRAM_CHAT_SCOPE: z.enum(['all', 'configured']).default('configured'),
});
