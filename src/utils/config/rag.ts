import { z } from 'zod';
import { booleanFromEnv } from './shared.js';

export const ragSchema = z.object({
  RAG_FEDERATION_ENABLED: booleanFromEnv.default(false),
});
