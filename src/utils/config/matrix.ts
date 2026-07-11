import { z } from 'zod';
import { blankToUndefined, optionalString } from './shared.js';

export const matrixSchema = z.object({
  // Matrix runtime (unencrypted rooms only). These three values are required
  // iff MESSAGING_PLATFORM=matrix; enforced in src/utils/config/index.ts.
  MATRIX_HOMESERVER_URL: optionalString,
  MATRIX_ACCESS_TOKEN: optionalString,
  MATRIX_OWNER_ID: optionalString,
  MATRIX_ROOMS_CONFIG_PATH: z.string().default('config/matrix-rooms.json'),
  // Same rationale as Telegram: anyone who knows the bot's MXID can invite
  // it to a room, so group ingestion defaults to configured rooms only.
  MATRIX_CHAT_SCOPE: z.preprocess(blankToUndefined, z.enum(['all', 'configured']).default('configured')),
});
