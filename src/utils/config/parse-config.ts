import { z } from 'zod';
import { aiSchema } from './ai.js';
import { bandSchema } from './band.js';
import { bridgeSchema } from './bridge.js';
import { coreSchema } from './core.js';
import { discordSchema } from './discord.js';
import { integrationsSchema } from './integrations.js';
import { monitoringSchema } from './monitoring.js';
import { matrixSchema } from './matrix.js';
import { ragSchema } from './rag.js';
import { telegramSchema } from './telegram.js';
import { vectorSchema } from './vector.js';
import { whatsappSchema } from './whatsapp.js';

export const configSchema = coreSchema
  .merge(aiSchema)
  .merge(whatsappSchema)
  .merge(discordSchema)
  .merge(telegramSchema)
  .merge(matrixSchema)
  .merge(bandSchema)
  .merge(bridgeSchema)
  .merge(ragSchema)
  .merge(vectorSchema)
  .merge(monitoringSchema)
  .merge(integrationsSchema)
  .superRefine((env, ctx) => {
    if (env.MESSAGING_PLATFORM === 'whatsapp' && !env.OWNER_JID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OWNER_JID'],
        message: 'OWNER_JID is required when MESSAGING_PLATFORM=whatsapp — set it in .env.whatsapp',
      });
    }

    if (env.MESSAGING_PLATFORM === 'telegram') {
      if (!env.TELEGRAM_BOT_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TELEGRAM_BOT_TOKEN'],
          message: 'TELEGRAM_BOT_TOKEN is required when MESSAGING_PLATFORM=telegram — set it in .env.telegram',
        });
      }
      if (!env.TELEGRAM_OWNER_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TELEGRAM_OWNER_ID'],
          message: 'TELEGRAM_OWNER_ID is required when MESSAGING_PLATFORM=telegram — set it in .env.telegram',
        });
      }
    }

    if (env.MESSAGING_PLATFORM === 'matrix') {
      if (!env.MATRIX_HOMESERVER_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MATRIX_HOMESERVER_URL'],
          message: 'MATRIX_HOMESERVER_URL is required when MESSAGING_PLATFORM=matrix — set it in .env.matrix',
        });
      }
      if (!env.MATRIX_ACCESS_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MATRIX_ACCESS_TOKEN'],
          message: 'MATRIX_ACCESS_TOKEN is required when MESSAGING_PLATFORM=matrix — set it in .env.matrix',
        });
      }
      if (!env.MATRIX_OWNER_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MATRIX_OWNER_ID'],
          message: 'MATRIX_OWNER_ID is required when MESSAGING_PLATFORM=matrix — set it in .env.matrix',
        });
      }
    }

    if (env.TELEGRAM_OWNER_ID && !/^\d+$/.test(env.TELEGRAM_OWNER_ID)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_OWNER_ID'],
        message: 'TELEGRAM_OWNER_ID must be numeric (a Telegram user id)',
      });
    }

    if (env.MATRIX_OWNER_ID && !/^@[^:]+:.+$/.test(env.MATRIX_OWNER_ID)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MATRIX_OWNER_ID'],
        message: 'MATRIX_OWNER_ID must be a Matrix user id like @user:server',
      });
    }

    if (env.MATRIX_HOMESERVER_URL) {
      const parsedUrl = z.string().url().safeParse(env.MATRIX_HOMESERVER_URL);
      if (!parsedUrl.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MATRIX_HOMESERVER_URL'],
          message: 'MATRIX_HOMESERVER_URL must be a valid URL',
        });
      }
    }
  });

export type Config = z.infer<typeof configSchema>;

export interface ParseConfigContext {
  readonly source?: string;
}

export type ParseConfigResult =
  | { ok: true; config: Config; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export function parseConfig(
  rawEnv: Record<string, string | undefined>,
  _context?: ParseConfigContext,
): ParseConfigResult {
  const parsed = configSchema.safeParse(rawEnv);
  const warnings: string[] = [];

  if (!parsed.success) {
    const errors = [
      'Invalid environment variables:',
      '  Offending variables:',
      ...parsed.error.issues.map((issue) => {
        const name = issue.path.join('.') || '<root>';
        return `  - ${name}: ${issue.message}`;
      }),
      '  Run `npm run setup` to create or repair your .env file.',
    ];
    return { ok: false, errors, warnings };
  }

  const errors: string[] = [];
  const allowedProviders = ['openrouter', 'anthropic', 'openai', 'gemini', 'bedrock'] as const;
  const requestedProviderOrder = parsed.data.AI_PROVIDER_ORDER
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);

  if (requestedProviderOrder.length === 0) {
    errors.push('❌ AI_PROVIDER_ORDER must include at least one provider (openrouter, anthropic, openai, gemini, bedrock)');
  }

  const invalidProviders = requestedProviderOrder.filter(
    (provider) => !allowedProviders.includes(provider as (typeof allowedProviders)[number]),
  );
  if (invalidProviders.length > 0) {
    errors.push(
      `❌ AI_PROVIDER_ORDER contains invalid providers: ${invalidProviders.join(', ')}`,
      '   Valid providers: openrouter, anthropic, openai, gemini, bedrock',
    );
  }

  const normalizedProviderOrderList = Array.from(new Set(requestedProviderOrder));
  if (requestedProviderOrder.length > 0 && invalidProviders.length === 0) {
    const configuredProviders = normalizedProviderOrderList.filter((provider) => {
      if (provider === 'openrouter') return !!parsed.data.OPENROUTER_API_KEY;
      if (provider === 'anthropic') return !!parsed.data.ANTHROPIC_API_KEY;
      if (provider === 'openai') {
        return parsed.data.OPENAI_AUTH_MODE === 'oauth' || !!parsed.data.OPENAI_API_KEY;
      }
      if (provider === 'gemini') return !!parsed.data.GEMINI_API_KEY;
      return !!parsed.data.BEDROCK_MODEL_ID;
    });

    if (configuredProviders.length === 0) {
      errors.push(
        '❌ No configured AI providers found in AI_PROVIDER_ORDER.',
        '   Configure at least one of: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, BEDROCK_MODEL_ID',
      );
    }
  }

  if (parsed.data.DB_DIALECT === 'postgres' && !parsed.data.DATABASE_URL) {
    const missingPostgresFields = [
      ['POSTGRES_HOST', parsed.data.POSTGRES_HOST],
      ['POSTGRES_DB', parsed.data.POSTGRES_DB],
      ['POSTGRES_USER', parsed.data.POSTGRES_USER],
      ['POSTGRES_PASSWORD', parsed.data.POSTGRES_PASSWORD],
    ].filter(([, value]) => !value).map(([key]) => key);

    if (missingPostgresFields.length > 0) {
      errors.push(
        '❌ DB_DIALECT=postgres requires DATABASE_URL or POSTGRES_* connection fields.',
        `   Missing: ${missingPostgresFields.join(', ')}`,
      );
    }
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(parsed.data.GITHUB_ISSUES_REPO)) {
    errors.push('❌ GITHUB_ISSUES_REPO must be in the form owner/repo');
  }

  if (
    parsed.data.DEMO_TURNSTILE_ENABLED
    && (!parsed.data.DEMO_TURNSTILE_SITE_KEY || !parsed.data.DEMO_TURNSTILE_SECRET_KEY)
  ) {
    errors.push('❌ DEMO_TURNSTILE_ENABLED=true requires DEMO_TURNSTILE_SITE_KEY and DEMO_TURNSTILE_SECRET_KEY');
  }

  if (
    parsed.data.BRIDGE_ENABLED
    && parsed.data.BRIDGE_TRANSPORT === 'amqp'
    && !parsed.data.BRIDGE_BROKER_URL
  ) {
    errors.push('❌ BRIDGE_TRANSPORT=amqp requires BRIDGE_BROKER_URL when BRIDGE_ENABLED=true');
  }

  if (
    parsed.data.BRIDGE_ENABLED
    && parsed.data.BRIDGE_TRANSPORT === 'http'
    && !parsed.data.MONITORING_TOKEN
  ) {
    errors.push('❌ bridge http transport authenticates with MONITORING_TOKEN — set it in .env');
  }

  if (parsed.data.WHATSAPP_SAFETY_MIN_DELAY_MS > parsed.data.WHATSAPP_SAFETY_MAX_DELAY_MS) {
    errors.push('❌ WHATSAPP_SAFETY_MIN_DELAY_MS must be less than or equal to WHATSAPP_SAFETY_MAX_DELAY_MS');
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const normalizedProviderOrder = normalizedProviderOrderList.join(',');
  const qdrantCollectionExplicit = rawEnv.QDRANT_COLLECTION !== undefined;
  const derivedQdrantCollection = !qdrantCollectionExplicit && parsed.data.INSTANCE_ID
    ? `garbanzo_memory_${parsed.data.INSTANCE_ID}`
    : parsed.data.QDRANT_COLLECTION;

  return {
    ok: true,
    config: {
      ...parsed.data,
      AI_PROVIDER_ORDER: normalizedProviderOrder,
      QDRANT_COLLECTION: derivedQdrantCollection,
    },
    warnings,
  };
}
