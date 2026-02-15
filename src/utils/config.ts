import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

loadDotenv({ path: resolve(PROJECT_ROOT, '.env') });

const envSchema = z.object({
  // Runtime platform
  MESSAGING_PLATFORM: z.enum(['whatsapp', 'discord']).default('whatsapp'),

  // AI — at least one must be set
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // Comma-separated provider priority order, eg: "openrouter,anthropic,openai"
  AI_PROVIDER_ORDER: z.string().default('openrouter,anthropic,openai'),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5-20250514'),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-sonnet-4-5'),
  OPENAI_MODEL: z.string().default('gpt-4.1'),

  // Ollama (local, optional)
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),

  // WhatsApp
  BOT_PHONE_NUMBER: z.string().optional(),

  // Feature API keys (all optional — features degrade gracefully)
  GOOGLE_API_KEY: z.string().optional(),
  MBTA_API_KEY: z.string().optional(),
  NEWSAPI_KEY: z.string().optional(),
  BRAVE_SEARCH_API_KEY: z.string().optional(),

  // Optional support / patronage links
  GITHUB_SPONSORS_URL: z.string().url().optional(),
  PATREON_URL: z.string().url().optional(),
  KOFI_URL: z.string().url().optional(),
  SUPPORT_CUSTOM_URL: z.string().url().optional(),
  SUPPORT_MESSAGE: z.string().optional(),

  // Optional GitHub issue automation for owner-approved feedback
  GITHUB_ISSUES_TOKEN: z.string().optional(),
  GITHUB_ISSUES_REPO: z.string().default('jjhickman/garbanzo-bot'),

  // Infrastructure
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  OWNER_JID: z.string().min(1, 'OWNER_JID is required — set in .env'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`   ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

// Ensure at least one AI provider is configured
if (!parsed.data.ANTHROPIC_API_KEY && !parsed.data.OPENROUTER_API_KEY && !parsed.data.OPENAI_API_KEY) {
  console.error(
    '❌ At least one AI provider key is required (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY)',
  );
  process.exit(1);
}

const ALLOWED_PROVIDERS = ['openrouter', 'anthropic', 'openai'] as const;
const requestedProviderOrder = parsed.data.AI_PROVIDER_ORDER
  .split(',')
  .map((provider) => provider.trim().toLowerCase())
  .filter(Boolean);

if (requestedProviderOrder.length === 0) {
  console.error('❌ AI_PROVIDER_ORDER must include at least one provider (openrouter, anthropic, openai)');
  process.exit(1);
}

const invalidProviders = requestedProviderOrder.filter(
  (provider) => !ALLOWED_PROVIDERS.includes(provider as (typeof ALLOWED_PROVIDERS)[number]),
);

if (invalidProviders.length > 0) {
  console.error(`❌ AI_PROVIDER_ORDER contains invalid providers: ${invalidProviders.join(', ')}`);
  console.error('   Valid providers: openrouter, anthropic, openai');
  process.exit(1);
}

const normalizedProviderOrder = Array.from(new Set(requestedProviderOrder)).join(',');

if (!/^[^/\s]+\/[^/\s]+$/.test(parsed.data.GITHUB_ISSUES_REPO)) {
  console.error('❌ GITHUB_ISSUES_REPO must be in the form owner/repo');
  process.exit(1);
}

export const config = {
  ...parsed.data,
  AI_PROVIDER_ORDER: normalizedProviderOrder,
};
export { PROJECT_ROOT };
