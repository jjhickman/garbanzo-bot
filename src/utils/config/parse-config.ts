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

/**
 * The cloud providers valid in `AI_PROVIDER_ORDER`. Ollama is deliberately NOT
 * here — it is a separate local fallback (`OLLAMA_BASE_URL`), never a member of
 * the cloud failover order. This is the single source of truth: the boot-time
 * validator and the browser wizard's provider picker both consume it, so the
 * wizard can never offer a provider the validator will reject.
 */
export const AI_PROVIDER_ORDER_VALUES = ['openrouter', 'anthropic', 'openai', 'gemini', 'bedrock'] as const;

const baseConfigSchema = coreSchema
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
  .merge(integrationsSchema);

export const configSchema = baseConfigSchema.superRefine((env, ctx) => {
    if (env.ADMIN_WRITE_ENABLED && !env.ADMIN_WRITE_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_WRITE_TOKEN'],
        message: 'ADMIN_WRITE_TOKEN is required when ADMIN_WRITE_ENABLED=true and must be at least 16 characters',
      });
    }

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

export interface ConfigIssue {
  code: string;
  path: (string | number)[];
  message: string;
  source: 'schema' | 'semantic';
  severity: 'error' | 'warning';
}

export type ParseConfigResult =
  | { ok: true; config: Config; issues: ConfigIssue[] }
  | { ok: false; issues: ConfigIssue[] };

function parsePrerequisites<K extends keyof Config>(
  rawEnv: Record<string, string | undefined>,
  keys: readonly K[],
): Pick<Config, K> | undefined {
  const values = {} as Pick<Config, K>;
  for (const key of keys) {
    const parsed = baseConfigSchema.shape[key].safeParse(rawEnv[String(key)]);
    if (!parsed.success) return undefined;
    Reflect.set(values, key, parsed.data);
  }
  return values;
}

function semanticIssue(
  code: string,
  path: (string | number)[],
  message: string,
): ConfigIssue {
  return { code, path, message, source: 'semantic', severity: 'error' };
}

export function parseConfig(
  rawEnv: Record<string, string | undefined>,
  _context?: ParseConfigContext,
): ParseConfigResult {
  const parsed = configSchema.safeParse(rawEnv);
  const issues: ConfigIssue[] = parsed.success ? [] : parsed.error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number'),
    message: issue.message,
    source: 'schema',
    severity: 'error',
  }));

  const allowedProviders = AI_PROVIDER_ORDER_VALUES;
  const providerConfig = parsePrerequisites(rawEnv, [
    'AI_PROVIDER_ORDER',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_AUTH_MODE',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'BEDROCK_MODEL_ID',
  ]);
  let normalizedProviderOrderList: string[] = [];
  if (providerConfig) {
    const requestedProviderOrder = providerConfig.AI_PROVIDER_ORDER
      .split(',')
      .map((provider) => provider.trim().toLowerCase())
      .filter(Boolean);
    normalizedProviderOrderList = Array.from(new Set(requestedProviderOrder));
    if (requestedProviderOrder.length === 0) {
      issues.push(semanticIssue(
        'ai.provider_order_empty',
        ['AI_PROVIDER_ORDER'],
        `AI_PROVIDER_ORDER must include at least one provider (${allowedProviders.join(', ')})`,
      ));
    }

    const invalidProviders = requestedProviderOrder.filter(
      (provider) => !allowedProviders.includes(provider as (typeof allowedProviders)[number]),
    );
    if (invalidProviders.length > 0) {
      issues.push(semanticIssue(
        'ai.provider_order_invalid',
        ['AI_PROVIDER_ORDER'],
        `AI_PROVIDER_ORDER contains invalid providers: ${invalidProviders.join(', ')}\nValid providers: ${allowedProviders.join(', ')}`,
      ));
    }

    if (requestedProviderOrder.length > 0 && invalidProviders.length === 0) {
      const configuredProviders = normalizedProviderOrderList.filter((provider) => {
        if (provider === 'openrouter') return !!providerConfig.OPENROUTER_API_KEY;
        if (provider === 'anthropic') return !!providerConfig.ANTHROPIC_API_KEY;
        if (provider === 'openai') {
          return providerConfig.OPENAI_AUTH_MODE === 'oauth' || !!providerConfig.OPENAI_API_KEY;
        }
        if (provider === 'gemini') return !!providerConfig.GEMINI_API_KEY;
        return !!providerConfig.BEDROCK_MODEL_ID;
      });
      if (configuredProviders.length === 0) {
        issues.push(semanticIssue(
          'ai.no_configured_provider',
          ['AI_PROVIDER_ORDER'],
          'No configured AI providers found in AI_PROVIDER_ORDER.\nConfigure at least one of: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, BEDROCK_MODEL_ID',
        ));
      }
    }
  }

  const postgres = parsePrerequisites(rawEnv, [
    'DB_DIALECT', 'DATABASE_URL', 'POSTGRES_HOST', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD',
  ]);
  if (postgres?.DB_DIALECT === 'postgres' && !postgres.DATABASE_URL) {
    const missingPostgresFields = [
      ['POSTGRES_HOST', postgres.POSTGRES_HOST],
      ['POSTGRES_DB', postgres.POSTGRES_DB],
      ['POSTGRES_USER', postgres.POSTGRES_USER],
      ['POSTGRES_PASSWORD', postgres.POSTGRES_PASSWORD],
    ].filter(([, value]) => !value).map(([key]) => key);

    if (missingPostgresFields.length > 0) {
      issues.push(semanticIssue(
        'database.postgres_connection_required',
        ['DATABASE_URL'],
        `DB_DIALECT=postgres requires DATABASE_URL or POSTGRES_* connection fields.\nMissing: ${missingPostgresFields.join(', ')}`,
      ));
    }
  }

  const github = parsePrerequisites(rawEnv, ['GITHUB_ISSUES_REPO']);
  if (github && !/^[^/\s]+\/[^/\s]+$/.test(github.GITHUB_ISSUES_REPO)) {
    issues.push(semanticIssue('github.repo_format', ['GITHUB_ISSUES_REPO'], 'GITHUB_ISSUES_REPO must be in the form owner/repo'));
  }

  const turnstile = parsePrerequisites(rawEnv, [
    'DEMO_TURNSTILE_ENABLED', 'DEMO_TURNSTILE_SITE_KEY', 'DEMO_TURNSTILE_SECRET_KEY',
  ]);
  if (
    turnstile?.DEMO_TURNSTILE_ENABLED
    && (!turnstile.DEMO_TURNSTILE_SITE_KEY || !turnstile.DEMO_TURNSTILE_SECRET_KEY)
  ) {
    issues.push(semanticIssue(
      'demo.turnstile_keys_required',
      ['DEMO_TURNSTILE_ENABLED'],
      'DEMO_TURNSTILE_ENABLED=true requires DEMO_TURNSTILE_SITE_KEY and DEMO_TURNSTILE_SECRET_KEY',
    ));
  }

  const bridge = parsePrerequisites(rawEnv, [
    'BRIDGE_ENABLED', 'BRIDGE_TRANSPORT', 'BRIDGE_BROKER_URL', 'MONITORING_TOKEN',
  ]);
  if (
    bridge?.BRIDGE_ENABLED
    && bridge.BRIDGE_TRANSPORT === 'amqp'
    && !bridge.BRIDGE_BROKER_URL
  ) {
    issues.push(semanticIssue(
      'bridge.amqp_broker_required',
      ['BRIDGE_BROKER_URL'],
      'BRIDGE_TRANSPORT=amqp requires BRIDGE_BROKER_URL when BRIDGE_ENABLED=true',
    ));
  }

  if (
    bridge?.BRIDGE_ENABLED
    && bridge.BRIDGE_TRANSPORT === 'http'
    && !bridge.MONITORING_TOKEN
  ) {
    issues.push(semanticIssue(
      'bridge.http_monitoring_token_required',
      ['MONITORING_TOKEN'],
      'bridge http transport authenticates with MONITORING_TOKEN — set it in .env',
    ));
  }

  const delays = parsePrerequisites(rawEnv, ['WHATSAPP_SAFETY_MIN_DELAY_MS', 'WHATSAPP_SAFETY_MAX_DELAY_MS']);
  if (delays && delays.WHATSAPP_SAFETY_MIN_DELAY_MS > delays.WHATSAPP_SAFETY_MAX_DELAY_MS) {
    issues.push(semanticIssue(
      'whatsapp.safety_delay_order',
      ['WHATSAPP_SAFETY_MIN_DELAY_MS'],
      'WHATSAPP_SAFETY_MIN_DELAY_MS must be less than or equal to WHATSAPP_SAFETY_MAX_DELAY_MS',
    ));
  }

  if (!parsed.success || issues.some((issue) => issue.severity === 'error')) {
    return { ok: false, issues };
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
    issues,
  };
}
