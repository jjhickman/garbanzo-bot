import { z } from 'zod';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { aiSchema } from './ai.js';
import { bandSchema } from './band.js';
import { bridgeSchema } from './bridge.js';
import { coreSchema } from './core.js';
import { discordSchema } from './discord.js';
import { integrationsSchema } from './integrations.js';
import { monitoringSchema } from './monitoring.js';
import { applyEnvLayers } from './shared.js';
import { vectorSchema } from './vector.js';
import { whatsappSchema } from './whatsapp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const processWithPkg = process as NodeJS.Process & { pkg?: unknown };
const PROJECT_ROOT = processWithPkg.pkg
  ? dirname(process.execPath)
  : resolve(__dirname, '../../..');

const realEnv = { ...process.env };
const envLayerResult = applyEnvLayers({ baseDir: PROJECT_ROOT, realEnv });
export const loadedEnvFiles = envLayerResult.loadedEnvFiles;

const envSchema = coreSchema
  .merge(aiSchema)
  .merge(whatsappSchema)
  .merge(discordSchema)
  .merge(bandSchema)
  .merge(bridgeSchema)
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
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error('  Offending variables:');
  for (const issue of parsed.error.issues) {
    const name = issue.path.join('.') || '<root>';
    console.error(`  - ${name}: ${issue.message}`);
  }
  console.error('  Run `npm run setup` to create or repair your .env file.');
  process.exit(1);
}

const ALLOWED_PROVIDERS = ['openrouter', 'anthropic', 'openai', 'gemini', 'bedrock'] as const;
const requestedProviderOrder = parsed.data.AI_PROVIDER_ORDER
  .split(',')
  .map((provider) => provider.trim().toLowerCase())
  .filter(Boolean);

if (requestedProviderOrder.length === 0) {
  console.error('❌ AI_PROVIDER_ORDER must include at least one provider (openrouter, anthropic, openai, gemini, bedrock)');
  process.exit(1);
}

const invalidProviders = requestedProviderOrder.filter(
  (provider) => !ALLOWED_PROVIDERS.includes(provider as (typeof ALLOWED_PROVIDERS)[number]),
);

if (invalidProviders.length > 0) {
  console.error(`❌ AI_PROVIDER_ORDER contains invalid providers: ${invalidProviders.join(', ')}`);
  console.error('   Valid providers: openrouter, anthropic, openai, gemini, bedrock');
  process.exit(1);
}

const normalizedProviderOrderList = Array.from(new Set(requestedProviderOrder));

const configuredProviders = normalizedProviderOrderList.filter((provider) => {
  if (provider === 'openrouter') return !!parsed.data.OPENROUTER_API_KEY;
  if (provider === 'anthropic') return !!parsed.data.ANTHROPIC_API_KEY;
  if (provider === 'openai') return parsed.data.OPENAI_AUTH_MODE === 'oauth' || !!parsed.data.OPENAI_API_KEY;
  if (provider === 'gemini') return !!parsed.data.GEMINI_API_KEY;
  return !!parsed.data.BEDROCK_MODEL_ID;
});

if (configuredProviders.length === 0) {
  console.error('❌ No configured AI providers found in AI_PROVIDER_ORDER.');
  console.error('   Configure at least one of: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, BEDROCK_MODEL_ID');
  process.exit(1);
}

const normalizedProviderOrder = normalizedProviderOrderList.join(',');

if (parsed.data.DB_DIALECT === 'postgres' && !parsed.data.DATABASE_URL) {
  const missingPostgresFields = [
    ['POSTGRES_HOST', parsed.data.POSTGRES_HOST],
    ['POSTGRES_DB', parsed.data.POSTGRES_DB],
    ['POSTGRES_USER', parsed.data.POSTGRES_USER],
    ['POSTGRES_PASSWORD', parsed.data.POSTGRES_PASSWORD],
  ].filter(([, value]) => !value).map(([key]) => key);

  if (missingPostgresFields.length > 0) {
    console.error('❌ DB_DIALECT=postgres requires DATABASE_URL or POSTGRES_* connection fields.');
    console.error(`   Missing: ${missingPostgresFields.join(', ')}`);
    process.exit(1);
  }
}

if (!/^[^/\s]+\/[^/\s]+$/.test(parsed.data.GITHUB_ISSUES_REPO)) {
  console.error('❌ GITHUB_ISSUES_REPO must be in the form owner/repo');
  process.exit(1);
}

if (parsed.data.DEMO_TURNSTILE_ENABLED) {
  if (!parsed.data.DEMO_TURNSTILE_SITE_KEY || !parsed.data.DEMO_TURNSTILE_SECRET_KEY) {
    console.error('❌ DEMO_TURNSTILE_ENABLED=true requires DEMO_TURNSTILE_SITE_KEY and DEMO_TURNSTILE_SECRET_KEY');
    process.exit(1);
  }
}

if (parsed.data.BRIDGE_ENABLED && parsed.data.BRIDGE_TRANSPORT === 'amqp' && !parsed.data.BRIDGE_BROKER_URL) {
  console.error('❌ BRIDGE_TRANSPORT=amqp requires BRIDGE_BROKER_URL when BRIDGE_ENABLED=true');
  process.exit(1);
}

if (parsed.data.BRIDGE_ENABLED && parsed.data.BRIDGE_TRANSPORT === 'http' && !parsed.data.MONITORING_TOKEN) {
  console.error('❌ bridge http transport authenticates with MONITORING_TOKEN — set it in .env');
  process.exit(1);
}

if (parsed.data.WHATSAPP_SAFETY_MIN_DELAY_MS > parsed.data.WHATSAPP_SAFETY_MAX_DELAY_MS) {
  console.error('❌ WHATSAPP_SAFETY_MIN_DELAY_MS must be less than or equal to WHATSAPP_SAFETY_MAX_DELAY_MS');
  process.exit(1);
}

// Smart default for QDRANT_COLLECTION: when INSTANCE_ID is explicitly set and
// QDRANT_COLLECTION is not, namespace the local vector collection per instance
// so two instances sharing the default Qdrant deployment don't silently
// bleed facts into each other. An explicit QDRANT_COLLECTION always wins, and
// single-instance deployments (no INSTANCE_ID) keep the plain default —
// zero behavior change for existing users.
const qdrantCollectionExplicit = process.env.QDRANT_COLLECTION !== undefined;
const derivedQdrantCollection = !qdrantCollectionExplicit && parsed.data.INSTANCE_ID
  ? `garbanzo_memory_${parsed.data.INSTANCE_ID}`
  : parsed.data.QDRANT_COLLECTION;

export const config = {
  ...parsed.data,
  AI_PROVIDER_ORDER: normalizedProviderOrder,
  QDRANT_COLLECTION: derivedQdrantCollection,
};
export const instanceId = config.INSTANCE_ID ?? config.MESSAGING_PLATFORM;
export { PROJECT_ROOT };
