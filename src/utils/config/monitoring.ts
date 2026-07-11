import { z } from 'zod';
import { blankToUndefined, booleanFromEnv, optionalString } from './shared.js';

const optionalAdminWriteToken = z.preprocess(
  blankToUndefined,
  z.string().trim().min(16).optional(),
);

export const monitoringSchema = z.object({
  // Infrastructure
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HEALTH_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  METRICS_ENABLED: booleanFromEnv.default(false),
  MONITORING_TOKEN: optionalString,
  ADMIN_WRITE_ENABLED: booleanFromEnv.default(false),
  ADMIN_WRITE_TOKEN: optionalAdminWriteToken,
  ADMIN_WRITE_PORT: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1).max(65535).default(3006),
  ),
  ADMIN_WRITE_BIND_HOST: z.preprocess(
    blankToUndefined,
    z.string().min(1).default('127.0.0.1'),
  ),
  // Owner admin page at /admin (token-gated with the login token).
  ADMIN_PAGE_ENABLED: booleanFromEnv.default(true),
  // Sunday-evening weekly recap DM to the owner.
  WEEKLY_RECAP_ENABLED: booleanFromEnv.default(true),
});
