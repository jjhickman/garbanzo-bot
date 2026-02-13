import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

loadDotenv({ path: resolve(PROJECT_ROOT, '.env') });

const envSchema = z.object({
  // AI — at least one must be set
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),

  // Ollama (local, optional)
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),

  // WhatsApp
  BOT_PHONE_NUMBER: z.string().optional(),

  // Feature API keys (all optional — features degrade gracefully)
  GOOGLE_API_KEY: z.string().optional(),
  MBTA_API_KEY: z.string().optional(),
  NEWSAPI_KEY: z.string().optional(),
  VETTLY_API_KEY: z.string().optional(),
  BRAVE_SEARCH_API_KEY: z.string().optional(),

  // Infrastructure
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  OWNER_JID: z.string().default('17819754407@s.whatsapp.net'),
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
if (!parsed.data.ANTHROPIC_API_KEY && !parsed.data.OPENROUTER_API_KEY) {
  console.error('❌ At least one AI provider key is required (ANTHROPIC_API_KEY or OPENROUTER_API_KEY)');
  process.exit(1);
}

export const config = parsed.data;
export { PROJECT_ROOT };
