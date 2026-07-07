import { z } from 'zod';
import { booleanFromEnv, optionalString } from './shared.js';

export const bridgeSchema = z.object({
  INSTANCE_ID: optionalString,
  BRIDGE_ENABLED: booleanFromEnv.default(false),
  BRIDGE_TRANSPORT: z.enum(['http', 'amqp']).default('http'),
  BRIDGE_BROKER_URL: optionalString,
  BRIDGE_SUMMARY_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(15),
  BRIDGE_MAX_TEXT: z.coerce.number().int().min(100).default(1500),
  SHARED_MEMORY_ENABLED: booleanFromEnv.default(false),
  QDRANT_SHARED_COLLECTION: z.string().min(1).default('garbanzo_shared'),
});
