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
});
