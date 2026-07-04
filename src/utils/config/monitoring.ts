import { z } from 'zod';
import { booleanFromEnv, optionalString } from './shared.js';

export const monitoringSchema = z.object({
  // Infrastructure
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HEALTH_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  METRICS_ENABLED: booleanFromEnv.default(false),
  MONITORING_TOKEN: optionalString,
  // Owner admin page at /admin (token-gated with the login token).
  ADMIN_PAGE_ENABLED: booleanFromEnv.default(true),
  // Sunday-evening weekly recap DM to the owner.
  WEEKLY_RECAP_ENABLED: booleanFromEnv.default(true),
});
