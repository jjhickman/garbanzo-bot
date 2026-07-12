import type { ZodObject, ZodRawShape } from 'zod';

import { aiSchema } from '../utils/config/ai.js';
import { bandSchema } from '../utils/config/band.js';
import { bridgeSchema } from '../utils/config/bridge.js';
import { coreSchema } from '../utils/config/core.js';
import { discordSchema } from '../utils/config/discord.js';
import { integrationsSchema } from '../utils/config/integrations.js';
import { matrixSchema } from '../utils/config/matrix.js';
import { monitoringSchema } from '../utils/config/monitoring.js';
import { ragSchema } from '../utils/config/rag.js';
import { telegramSchema } from '../utils/config/telegram.js';
import { vectorSchema } from '../utils/config/vector.js';
import { whatsappSchema } from '../utils/config/whatsapp.js';

type SecretClassification = Readonly<Record<string, boolean>>;

/**
 * Explicit classification for every leaf in the runtime env schema. A module
 * initialization check below makes schema additions fail fast until a reviewer
 * chooses true or false here.
 */
export const SCHEMA_SECRET_CLASSIFICATION = {
  ADMIN_PAGE_ENABLED: false,
  ADMIN_WRITE_BIND_HOST: false,
  ADMIN_WRITE_ENABLED: false,
  ADMIN_WRITE_PORT: false,
  ADMIN_WRITE_TOKEN: true,
  AI_PROVIDER_ORDER: false,
  AI_TOOL_CALLING: false,
  AI_TOOL_MAX_ITERATIONS: false,
  ANTHROPIC_API_KEY: true,
  ANTHROPIC_MODEL: false,
  ANTHROPIC_PRICING_INPUT_PER_M: false,
  ANTHROPIC_PRICING_OUTPUT_PER_M: false,
  ANTHROPIC_PROMPT_CACHING: false,
  BAND_FEATURES_ENABLED: false,
  BEDROCK_MAX_TOKENS: false,
  BEDROCK_MODEL_ID: false,
  BEDROCK_PRICING_INPUT_PER_M: false,
  BEDROCK_PRICING_OUTPUT_PER_M: false,
  BEDROCK_REGION: false,
  BOT_PHONE_NUMBER: true,
  BRAVE_SEARCH_API_KEY: true,
  BRIDGE_BROKER_URL: true,
  BRIDGE_ENABLED: false,
  BRIDGE_MAX_TEXT: false,
  BRIDGE_SUMMARY_INTERVAL_MINUTES: false,
  BRIDGE_TRANSPORT: false,
  CLOUD_MAX_TOKENS: false,
  CLOUD_REQUEST_TIMEOUT_MS: false,
  CONTEXT_SESSION_GAP_MINUTES: false,
  CONTEXT_SESSION_MAX_RETRIEVED: false,
  CONTEXT_SESSION_MEMORY_ENABLED: false,
  CONTEXT_SESSION_MIN_MESSAGES: false,
  CONTEXT_SESSION_SUMMARY_VERSION: false,
  DATABASE_URL: true,
  DB_DIALECT: false,
  DEMO_TURNSTILE_ENABLED: false,
  DEMO_TURNSTILE_SECRET_KEY: true,
  DEMO_TURNSTILE_SITE_KEY: false,
  DISCORD_BOT_TOKEN: true,
  DISCORD_CHANNELS_CONFIG_PATH: false,
  DISCORD_DEMO: false,
  DISCORD_DEMO_BIND_HOST: false,
  DISCORD_DEMO_PORT: false,
  DISCORD_DIGEST_CHANNEL_ID: false,
  DISCORD_GATEWAY_ENABLED: false,
  DISCORD_INTERACTIONS_BIND_HOST: false,
  DISCORD_INTERACTIONS_PORT: false,
  DISCORD_OWNER_ID: false,
  DISCORD_PRACTICE_CHANNEL_ID: false,
  DISCORD_PUBLIC_KEY: false,
  DISCORD_RECAP_CHANNEL_ID: false,
  EVENT_REMINDERS_ENABLED: false,
  EVENT_REMINDER_LEAD_MINUTES: false,
  FIRECRAWL_API_KEY: true,
  GEMINI_API_KEY: true,
  GEMINI_MODEL: false,
  GEMINI_PRICING_INPUT_PER_M: false,
  GEMINI_PRICING_OUTPUT_PER_M: false,
  GITHUB_ISSUES_REPO: false,
  GITHUB_ISSUES_TOKEN: true,
  GITHUB_SPONSORS_URL: false,
  GOOGLE_API_KEY: true,
  GOOGLE_SEARCH_ENGINE_ID: false,
  HEALTH_BIND_HOST: false,
  HEALTH_PORT: false,
  INSTANCE_ID: false,
  KOFI_URL: false,
  LOG_LEVEL: false,
  MATRIX_ACCESS_TOKEN: true,
  MATRIX_CHAT_SCOPE: false,
  MATRIX_HOMESERVER_URL: false,
  MATRIX_OWNER_ID: false,
  MATRIX_ROOMS_CONFIG_PATH: false,
  MBTA_API_KEY: true,
  MEMORY_AUTO_EXTRACT: false,
  MEMORY_AUTO_EXTRACT_INTERVAL_MINUTES: false,
  MEMORY_AUTO_EXTRACT_MIN_MESSAGES: false,
  MEMORY_AUTO_MAX_FACTS: false,
  MESSAGING_PLATFORM: false,
  METRICS_ENABLED: false,
  MONITORING_TOKEN: true,
  NEWSAPI_KEY: true,
  OLLAMA_BASE_URL: false,
  OLLAMA_MODEL: false,
  OPENAI_API_KEY: true,
  OPENAI_AUTH_MODE: false,
  OPENAI_MODEL: false,
  OPENAI_PRICING_INPUT_PER_M: false,
  OPENAI_PRICING_OUTPUT_PER_M: false,
  OPENAI_REASONING_EFFORT: false,
  OPENROUTER_API_KEY: true,
  OPENROUTER_MODEL: false,
  OWNER_JID: true,
  PATREON_URL: false,
  POSTGRES_DB: false,
  POSTGRES_HOST: false,
  POSTGRES_PASSWORD: true,
  POSTGRES_PORT: false,
  POSTGRES_SSL: false,
  POSTGRES_SSL_REJECT_UNAUTHORIZED: false,
  POSTGRES_USER: false,
  QDRANT_API_KEY: true,
  QDRANT_COLLECTION: false,
  QDRANT_SHARED_COLLECTION: false,
  QDRANT_URL: false,
  RAG_FEDERATION_ENABLED: false,
  REHEARSAL_REMINDER_LEAD_MINUTES: false,
  RETRY_ATTEMPT_TIMEOUT_MS: false,
  SEARXNG_BASE_URL: false,
  SHARED_MEMORY_ENABLED: false,
  SLACK_BOT_TOKEN: true,
  SLACK_BOT_USER_ID: false,
  SLACK_CLIENT_ID: false,
  SLACK_CLIENT_SECRET: true,
  SLACK_DEMO: false,
  SLACK_DEMO_BIND_HOST: false,
  SLACK_DEMO_PORT: false,
  SLACK_EVENTS_BIND_HOST: false,
  SLACK_EVENTS_PORT: false,
  SLACK_REFRESH_TOKEN: true,
  SLACK_SIGNING_SECRET: true,
  SLACK_TOKEN_ROTATE_MIN_BUFFER: false,
  SLACK_TOKEN_STATE_FILE: false,
  SUPPORT_CUSTOM_URL: false,
  SUPPORT_MESSAGE: false,
  TELEGRAM_BOT_TOKEN: true,
  TELEGRAM_CHATS_CONFIG_PATH: false,
  TELEGRAM_CHAT_SCOPE: false,
  TELEGRAM_OWNER_ID: false,
  VECTOR_EMBEDDING_DIMENSIONS: false,
  VECTOR_EMBEDDING_MAX_CHARS: false,
  VECTOR_EMBEDDING_MODEL: false,
  VECTOR_EMBEDDING_PROVIDER: false,
  VECTOR_EMBEDDING_TIMEOUT_MS: false,
  VECTOR_STORE: false,
  WEB_SEARCH_PROVIDER: false,
  WEEKLY_RECAP_ENABLED: false,
  WHATSAPP_CHAT_SCOPE: false,
  WHATSAPP_LOGIN_MODE: false,
  WHATSAPP_LOGIN_TOKEN: true,
  WHATSAPP_SAFETY_AUTO_PAUSE_AT: false,
  WHATSAPP_SAFETY_DAY1_LIMIT: false,
  WHATSAPP_SAFETY_ENABLED: false,
  WHATSAPP_SAFETY_MAX_DELAY_MS: false,
  WHATSAPP_SAFETY_MAX_PER_DAY: false,
  WHATSAPP_SAFETY_MAX_PER_HOUR: false,
  WHATSAPP_SAFETY_MAX_PER_MINUTE: false,
  WHATSAPP_SAFETY_MIN_DELAY_MS: false,
  WHATSAPP_SAFETY_WARMUP_DAYS: false,
  WHATSAPP_SET_PROFILE_NAME: false,
} as const satisfies SecretClassification;

/** Wizard-emitted keys that are not runtime-schema leaves yet. */
const WIZARD_ONLY_SECRET_CLASSIFICATION = {
  APP_VERSION: false,
  BRIDGE_BROKER_PASSWORD: true,
  BRIDGE_BROKER_USER: false,
  COMPOSE_PROFILES: false,
  DISCORD_CLIENT_ID: false,
} as const satisfies SecretClassification;

const SCHEMAS: ReadonlyArray<ZodObject<ZodRawShape>> = [
  aiSchema,
  bandSchema,
  bridgeSchema,
  coreSchema,
  discordSchema,
  integrationsSchema,
  matrixSchema,
  monitoringSchema,
  ragSchema,
  telegramSchema,
  vectorSchema,
  whatsappSchema,
];

const schemaKeys = [...new Set(SCHEMAS.flatMap((schema) => Object.keys(schema.shape)))].sort();
const classifiedKeys = Object.keys(SCHEMA_SECRET_CLASSIFICATION).sort();

if (schemaKeys.length !== classifiedKeys.length
  || schemaKeys.some((key, index) => key !== classifiedKeys[index])) {
  const missing = schemaKeys.filter((key) => !(key in SCHEMA_SECRET_CLASSIFICATION));
  const stale = classifiedKeys.filter((key) => !schemaKeys.includes(key));
  throw new Error(
    `Secret classification is out of sync with env schemas (missing: ${missing.join(', ') || 'none'}; stale: ${stale.join(', ') || 'none'})`,
  );
}

export const KNOWN_SCHEMA_KEYS: readonly string[] = Object.freeze(schemaKeys);

const SECRET_NAME_HEURISTIC = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|PASS)$/i;
const SENSITIVE_QUERY_PARAM = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|key|secret|password|passwd|pass)(?:$|[_-])/i;

const PUBLIC_JSON_KEYS = new Set([
  '_comment', '_comment_embedding_models', 'groups', 'mentionPatterns', 'admins', 'owner', 'moderators',
  'name', 'enabled', 'requireMention', 'enabledFeatures', 'persona', 'ownerId', 'bandRoleIds',
  'introductionsChannelId', 'eventsChannelId', 'channels', 'features', 'chats', 'rooms', 'alias', 'sources',
  'id', 'label', 'collection', 'textField', 'embedding', 'provider', 'model', 'dimensions', 'maxHits',
  'minScore', 'instances', 'routes', 'platform', 'direction', 'from', 'modeToWhatsApp', 'modeToDiscord',
  'relayCommands', 'ingestRelayed', 'instance', 'chatId', 'url',
]);

function quotedValueBounds(value: string): { start: number; end: number } | undefined {
  const start = value.search(/\S/);
  if (start < 0) return undefined;
  const quote = value[start];
  if (quote !== '"' && quote !== "'") return undefined;

  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    let backslashes = 0;
    for (let previous = index - 1; previous >= 0 && value[previous] === '\\'; previous -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return { start, end: index };
  }
  return { start, end: -1 };
}

function scalarValue(value: string): string {
  const bounds = quotedValueBounds(value);
  if (bounds && bounds.end >= 0) return value.slice(bounds.start + 1, bounds.end);
  const comment = value.search(/\s+#/);
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

export function hasCredentialsInUrl(value: string): boolean {
  const unquoted = scalarValue(value);
  try {
    const url = new URL(unquoted);
    return url.username.length > 0
      || url.password.length > 0
      || [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_PARAM.test(key));
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(unquoted)
      || /[?&][^=&]*(?:api[_-]?key|token|key|secret|password|passwd|pass)[^=&]*=/i.test(unquoted);
  }
}

export function isJsonSecretPath(path: readonly string[], value: unknown): boolean {
  const key = path.at(-1) ?? '';
  if (/^(?:jid|api.?key|token|secret|password|passwd|pass)$/i.test(key)) return true;
  if (!PUBLIC_JSON_KEYS.has(key)) return true;
  return typeof value === 'string' && hasCredentialsInUrl(value);
}

export function maskJsonSecrets(value: unknown, path: readonly string[] = []): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => maskJsonSecrets(item, [...path, String(index)]));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      maskJsonSecrets(child, [...path, key]),
    ]));
  }
  return isJsonSecretPath(path, value)
    ? { set: value !== null && value !== undefined && value !== '' }
    : value;
}

export function isSecretKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  // Explicit classifications win over the name heuristic so a deliberately
  // public key (DISCORD_PUBLIC_KEY, DEMO_TURNSTILE_SITE_KEY) isn't force-masked
  // just because it ends in _KEY. The heuristic and deny-by-default only apply
  // to keys with no explicit classification.
  const wizardClassification = WIZARD_ONLY_SECRET_CLASSIFICATION[normalized as keyof typeof WIZARD_ONLY_SECRET_CLASSIFICATION];
  if (wizardClassification !== undefined) return wizardClassification;

  const schemaClassification = SCHEMA_SECRET_CLASSIFICATION[normalized as keyof typeof SCHEMA_SECRET_CLASSIFICATION];
  if (schemaClassification !== undefined) return schemaClassification;

  if (SECRET_NAME_HEURISTIC.test(normalized)) return true;

  return true;
}

export function redactValue(key: string, value: string): string {
  if (!value.trim()) return value;
  return isSecretKey(key) || hasCredentialsInUrl(value) ? '[REDACTED]' : value;
}

export function redactEnvContent(content: string): string {
  const physicalLines = content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
  const logicalRecords: string[] = [];

  for (let index = 0; index < physicalLines.length; index += 1) {
    let record = physicalLines[index] ?? '';
    const assignment = record.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)([\s\S]*)$/);
    if (assignment) {
      let bounds = quotedValueBounds(assignment[4] ?? '');
      while (bounds?.end === -1 && index + 1 < physicalLines.length) {
        index += 1;
        record += physicalLines[index] ?? '';
        const continued = record.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)([\s\S]*)$/);
        bounds = quotedValueBounds(continued?.[4] ?? '');
      }
    }
    logicalRecords.push(record);
  }

  return logicalRecords.map((record) => {
    const match = record.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)([\s\S]*)$/);
    if (!match) return record;
    const [, prefix = '', key, separator = '=', rawValue = ''] = match;
    if (!key || !rawValue.trim()) return record;
    if (!isSecretKey(key) && !hasCredentialsInUrl(rawValue)) return record;

    const newline = rawValue.match(/(\r\n|\n|\r)$/)?.[1] ?? '';
    const valueWithoutNewline = newline ? rawValue.slice(0, -newline.length) : rawValue;
    const bounds = quotedValueBounds(valueWithoutNewline);
    const suffix = bounds && bounds.end >= 0 ? valueWithoutNewline.slice(bounds.end + 1) : '';
    return `${prefix}${key}${separator}[REDACTED]${suffix}${newline}`;
  }).join('');
}
