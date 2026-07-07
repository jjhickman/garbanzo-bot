import { z } from 'zod';
import { optionalString } from './shared.js';

export const coreSchema = z.object({
  // Runtime platform
  MESSAGING_PLATFORM: z.enum(['whatsapp', 'discord', 'slack', 'telegram', 'matrix']).default('discord'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  OWNER_JID: optionalString,
});
