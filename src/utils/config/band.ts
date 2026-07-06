import { z } from 'zod';
import { booleanFromEnv } from './shared.js';

export const bandSchema = z.object({
  REHEARSAL_REMINDER_LEAD_MINUTES: z.coerce.number().int().min(10).max(1440).default(120),

  // Shared band memory (songs, setlists, rehearsal notes)
  BAND_FEATURES_ENABLED: booleanFromEnv.default(false),
});
