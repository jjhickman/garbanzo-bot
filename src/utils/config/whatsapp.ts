import { z } from 'zod';
import { booleanFromEnv, optionalString } from './shared.js';

export const whatsappSchema = z.object({
  // WhatsApp
  BOT_PHONE_NUMBER: optionalString,
  WHATSAPP_LOGIN_MODE: z.enum(['web', 'terminal', 'both']).default('web'),
  // Empty string normalizes to undefined so a strong random token is generated at
  // startup instead of an all-empty (bypassable) token guard.
  WHATSAPP_LOGIN_TOKEN: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().optional(),
  ),
  WHATSAPP_SAFETY_ENABLED: booleanFromEnv.default(true),
  WHATSAPP_SAFETY_MAX_PER_MINUTE: z.coerce.number().int().min(1).max(100).default(5),
  WHATSAPP_SAFETY_MAX_PER_HOUR: z.coerce.number().int().min(1).max(5000).default(100),
  WHATSAPP_SAFETY_MAX_PER_DAY: z.coerce.number().int().min(1).max(50000).default(2000),
  WHATSAPP_SAFETY_MIN_DELAY_MS: z.coerce.number().int().min(0).max(60000).default(2500),
  WHATSAPP_SAFETY_MAX_DELAY_MS: z.coerce.number().int().min(0).max(120000).default(7000),
  WHATSAPP_SAFETY_WARMUP_DAYS: z.coerce.number().int().min(0).max(30).default(10),
  WHATSAPP_SAFETY_DAY1_LIMIT: z.coerce.number().int().min(1).max(5000).default(2000),
  WHATSAPP_SAFETY_AUTO_PAUSE_AT: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  EVENT_REMINDERS_ENABLED: booleanFromEnv.default(true),
  EVENT_REMINDER_LEAD_MINUTES: z.coerce.number().int().min(10).max(1440).default(120),
});
