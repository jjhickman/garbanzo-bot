import { z } from 'zod';
import { blankToUndefined, booleanFromEnv, optionalString } from './shared.js';

export const bridgeSchema = z.object({
  INSTANCE_ID: optionalString,
  BRIDGE_ENABLED: booleanFromEnv.default(false),
  // blankToUndefined must wrap the schema+default together (not the other
  // way around): z.preprocess(fn, inner) runs fn on the raw value BEFORE
  // inner sees it, so an empty string becomes undefined first and inner's
  // own `.default(...)` applies. `inner.default(...)` alone would not help —
  // ZodDefault only substitutes when the *raw, pre-preprocess* input is
  // undefined, which a written-but-blank `KEY=` line never is. The setup
  // wizard writes these unconditionally (even blank) when bridging isn't
  // configured, so this must tolerate blank without failing enum/coercion/
  // min-length validation.
  BRIDGE_TRANSPORT: z.preprocess(blankToUndefined, z.enum(['http', 'amqp']).default('http')),
  BRIDGE_BROKER_URL: optionalString,
  BRIDGE_SUMMARY_INTERVAL_MINUTES: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(15)),
  BRIDGE_MAX_TEXT: z.preprocess(blankToUndefined, z.coerce.number().int().min(100).default(1500)),
  SHARED_MEMORY_ENABLED: booleanFromEnv.default(false),
  QDRANT_SHARED_COLLECTION: z.preprocess(blankToUndefined, z.string().min(1).default('garbanzo_shared')),
});
