import { z } from 'zod';
import { booleanFromEnv, optionalString, optionalUrl } from './shared.js';

export const integrationsSchema = z.object({
  // Feature API keys (all optional — features degrade gracefully)
  GOOGLE_API_KEY: optionalString,
  MBTA_API_KEY: optionalString,
  NEWSAPI_KEY: optionalString,
  FIRECRAWL_API_KEY: optionalString,
  BRAVE_SEARCH_API_KEY: optionalString,
  GOOGLE_SEARCH_ENGINE_ID: optionalString,
  SEARXNG_BASE_URL: optionalUrl,
  WEB_SEARCH_PROVIDER: z.enum(['firecrawl', 'brave', 'google', 'searxng']).optional(),

  // Optional external links for owner messaging
  GITHUB_SPONSORS_URL: optionalUrl,
  PATREON_URL: optionalUrl,
  KOFI_URL: optionalUrl,
  SUPPORT_CUSTOM_URL: optionalUrl,
  SUPPORT_MESSAGE: optionalString,

  // Optional GitHub issue automation for owner-approved feedback
  GITHUB_ISSUES_TOKEN: optionalString,
  GITHUB_ISSUES_REPO: z.string().default('owner/repo'),

  // Database
  DB_DIALECT: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DATABASE_URL: optionalString,
  POSTGRES_HOST: optionalString,
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  POSTGRES_DB: optionalString,
  POSTGRES_USER: optionalString,
  POSTGRES_PASSWORD: optionalString,
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
});
