import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const processWithPkg = process as NodeJS.Process & { pkg?: unknown };
const PROJECT_ROOT = processWithPkg.pkg
  ? dirname(process.execPath)
  : resolve(__dirname, '../..');

loadDotenv({ path: resolve(PROJECT_ROOT, '.env') });

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional(),
);

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off', ''].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const envSchema = z.object({
  // Runtime platform
  MESSAGING_PLATFORM: z.enum(['whatsapp', 'discord', 'slack', 'teams']).default('whatsapp'),

  // AI — at least one must be set
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  // Comma-separated provider priority order, eg: "openrouter,anthropic,openai,gemini,bedrock"
  AI_PROVIDER_ORDER: z.string().default('anthropic,openai'),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  // Anthropic pricing (USD per 1M tokens) for cost tracking — default: Claude Haiku 4.5 ($1/$5).
  ANTHROPIC_PRICING_INPUT_PER_M: z.coerce.number().min(0).default(1.0),
  ANTHROPIC_PRICING_OUTPUT_PER_M: z.coerce.number().min(0).default(5.0),
  // Cache the (static) persona system prompt so repeat calls read it at 10% of input price.
  ANTHROPIC_PROMPT_CACHING: booleanFromEnv.default(true),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-sonnet-4-5'),
  OPENAI_MODEL: z.string().default('gpt-5.4-mini'),
  // OpenAI pricing (USD per 1M tokens) for cost tracking — default: gpt-5.4-mini ($0.75/$4.50).
  OPENAI_PRICING_INPUT_PER_M: z.coerce.number().min(0).default(0.75),
  OPENAI_PRICING_OUTPUT_PER_M: z.coerce.number().min(0).default(4.5),
  // apikey (default): api.openai.com with OPENAI_API_KEY. oauth (EXPERIMENTAL,
  // ToS-grey): "Sign in with ChatGPT" via `npm run openai:login`, calls the
  // ChatGPT backend. Always falls back to the next provider on failure.
  OPENAI_AUTH_MODE: z.enum(['apikey', 'oauth']).default('apikey'),
  GEMINI_MODEL: z.string().default('gemini-1.5-flash'),
  GEMINI_PRICING_INPUT_PER_M: z.coerce.number().min(0).default(0.0),
  GEMINI_PRICING_OUTPUT_PER_M: z.coerce.number().min(0).default(0.0),
  CLOUD_MAX_TOKENS: z.coerce.number().int().min(64).max(4096).default(1024),
  CLOUD_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  RETRY_ATTEMPT_TIMEOUT_MS: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int().min(1000).max(120000).optional(),
  ),
  AI_TOOL_CALLING: booleanFromEnv.default(false),
  AI_TOOL_MAX_ITERATIONS: z.coerce.number().int().min(1).max(5).default(3),

  // AWS Bedrock (uses AWS credentials via default provider chain)
  BEDROCK_REGION: z.string().default('us-east-1'),
  BEDROCK_MODEL_ID: z.string().optional(),
  BEDROCK_MAX_TOKENS: z.coerce.number().int().min(1).max(4096).default(1024),
  BEDROCK_PRICING_INPUT_PER_M: z.coerce.number().min(0).default(0.0),
  BEDROCK_PRICING_OUTPUT_PER_M: z.coerce.number().min(0).default(0.0),

  // Ollama (local, optional)
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('qwen3:8b'),

  // WhatsApp
  BOT_PHONE_NUMBER: z.string().optional(),
  WHATSAPP_LOGIN_MODE: z.enum(['web', 'terminal', 'both']).default('web'),
  // Empty string normalizes to undefined so a strong random token is generated at
  // startup instead of an all-empty (bypassable) token guard.
  WHATSAPP_LOGIN_TOKEN: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().optional(),
  ),
  WHATSAPP_SAFETY_ENABLED: booleanFromEnv.default(true),
  WHATSAPP_SAFETY_MAX_PER_MINUTE: z.coerce.number().int().min(1).max(100).default(5),
  WHATSAPP_SAFETY_MAX_PER_HOUR: z.coerce.number().int().min(1).max(5000).default(100),
  WHATSAPP_SAFETY_MAX_PER_DAY: z.coerce.number().int().min(1).max(50000).default(2000),
  WHATSAPP_SAFETY_MIN_DELAY_MS: z.coerce.number().int().min(0).max(60000).default(2500),
  WHATSAPP_SAFETY_MAX_DELAY_MS: z.coerce.number().int().min(0).max(120000).default(7000),
  WHATSAPP_SAFETY_WARMUP_DAYS: z.coerce.number().int().min(0).max(30).default(10),
  WHATSAPP_SAFETY_DAY1_LIMIT: z.coerce.number().int().min(1).max(5000).default(2000),
  WHATSAPP_SAFETY_AUTO_PAUSE_AT: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),

  // Feature API keys (all optional — features degrade gracefully)
  GOOGLE_API_KEY: z.string().optional(),
  MBTA_API_KEY: z.string().optional(),
  NEWSAPI_KEY: z.string().optional(),
  BRAVE_SEARCH_API_KEY: z.string().optional(),

  // Optional external links for owner messaging
  GITHUB_SPONSORS_URL: optionalUrl,
  PATREON_URL: optionalUrl,
  KOFI_URL: optionalUrl,
  SUPPORT_CUSTOM_URL: optionalUrl,
  SUPPORT_MESSAGE: z.string().optional(),

  // Optional GitHub issue automation for owner-approved feedback
  GITHUB_ISSUES_TOKEN: z.string().optional(),
  GITHUB_ISSUES_REPO: z.string().default('owner/repo'),

  // Infrastructure
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HEALTH_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  METRICS_ENABLED: booleanFromEnv.default(false),
  // Owner admin page at /admin (token-gated with the login token).
  ADMIN_PAGE_ENABLED: booleanFromEnv.default(true),

  // Slack runtime
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_BOT_USER_ID: z.string().optional(),
  // Optional token rotation support (recommended for expiring Slack tokens)
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_REFRESH_TOKEN: z.string().optional(),
  SLACK_TOKEN_STATE_FILE: z.string().default('data/slack-token-state.json'),
  SLACK_TOKEN_ROTATE_MIN_BUFFER: z.coerce.number().int().min(1).max(120).default(5),
  SLACK_EVENTS_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  SLACK_EVENTS_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  // Slack demo runtime (non-production)
  SLACK_DEMO: booleanFromEnv.default(false),
  SLACK_DEMO_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  SLACK_DEMO_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  DEMO_TURNSTILE_ENABLED: booleanFromEnv.default(false),
  DEMO_TURNSTILE_SITE_KEY: z.string().optional(),
  DEMO_TURNSTILE_SECRET_KEY: z.string().optional(),

  // Discord runtime
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_PUBLIC_KEY: z.string().optional(),
  DISCORD_INTERACTIONS_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  DISCORD_INTERACTIONS_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  // Discord demo runtime (non-production)
  DISCORD_DEMO: booleanFromEnv.default(false),
  DISCORD_DEMO_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  DISCORD_DEMO_BIND_HOST: z.string().min(1).default('127.0.0.1'),

  // Database
  DB_DIALECT: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DATABASE_URL: z.string().optional(),
  POSTGRES_HOST: z.string().optional(),
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  POSTGRES_DB: z.string().optional(),
  POSTGRES_USER: z.string().optional(),
  POSTGRES_PASSWORD: z.string().optional(),
  POSTGRES_SSL: booleanFromEnv.default(false),
  POSTGRES_SSL_REJECT_UNAUTHORIZED: booleanFromEnv.default(false),

  // Conversation session memory
  CONTEXT_SESSION_MEMORY_ENABLED: booleanFromEnv.default(true),
  CONTEXT_SESSION_GAP_MINUTES: z.coerce.number().int().min(5).max(720).default(30),
  CONTEXT_SESSION_MIN_MESSAGES: z.coerce.number().int().min(2).max(100).default(4),
  CONTEXT_SESSION_MAX_RETRIEVED: z.coerce.number().int().min(1).max(12).default(3),
  CONTEXT_SESSION_SUMMARY_VERSION: z.coerce.number().int().min(1).max(20).default(1),

  // Long-term community memory extraction
  MEMORY_AUTO_EXTRACT: booleanFromEnv.default(false),
  MEMORY_AUTO_EXTRACT_MIN_MESSAGES: z.coerce.number().int().min(5).max(500).default(25),
  MEMORY_AUTO_EXTRACT_INTERVAL_MINUTES: z.coerce.number().int().min(10).max(10080).default(360),
  MEMORY_AUTO_MAX_FACTS: z.coerce.number().int().min(10).max(2000).default(200),

  // Vector embedding pipeline
  VECTOR_EMBEDDING_PROVIDER: z.enum(['deterministic', 'openai']).default('deterministic'),
  VECTOR_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  VECTOR_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(12000),
  VECTOR_EMBEDDING_MAX_CHARS: z.coerce.number().int().min(256).max(12000).default(4000),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  OWNER_JID: z.string().min(1, 'OWNER_JID is required — set in .env'),
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

if (parsed.data.WHATSAPP_SAFETY_MIN_DELAY_MS > parsed.data.WHATSAPP_SAFETY_MAX_DELAY_MS) {
  console.error('❌ WHATSAPP_SAFETY_MIN_DELAY_MS must be less than or equal to WHATSAPP_SAFETY_MAX_DELAY_MS');
  process.exit(1);
}

export const config = {
  ...parsed.data,
  AI_PROVIDER_ORDER: normalizedProviderOrder,
};
export { PROJECT_ROOT };
