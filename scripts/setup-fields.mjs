import { randomBytes } from 'node:crypto';

/**
 * Declarative field table + pure resolvers for the setup wizard.
 *
 * Extracted from setup.mjs so the non-interactive resolution and the
 * secret-masking rules are unit-testable and defined in one place instead of
 * repeated `nonInteractive ? cli : prompt` ternaries.
 */

/**
 * Simple text/model/infra fields resolved uniformly. Each entry:
 *   { env, cli, default, secret? }
 * `secret: true` fields never render their raw value in a prompt hint.
 * (APP_VERSION is intentionally omitted — its default is computed at runtime.)
 *
 * SHARED_FIELDS / WHATSAPP_FIELDS / DISCORD_FIELDS partition every
 * FIELD_TABLE entry by which env file the wizard emits it into: `.env`
 * (shared across every platform instance), `.env.whatsapp`, or
 * `.env.discord` — see docs/superpowers/specs/2026-07-04-modular-config-design.md.
 * Every env key belongs to exactly one of these three lists.
 */
export const SHARED_FIELDS = [
  { env: 'ANTHROPIC_API_KEY', cli: 'anthropic-key', default: '', secret: true },
  { env: 'OPENROUTER_API_KEY', cli: 'openrouter-key', default: '', secret: true },
  { env: 'OPENAI_API_KEY', cli: 'openai-key', default: '', secret: true },
  { env: 'GEMINI_API_KEY', cli: 'gemini-key', default: '', secret: true },
  { env: 'ANTHROPIC_MODEL', cli: 'anthropic-model', default: 'claude-haiku-4-5-20251001' },
  { env: 'OPENROUTER_MODEL', cli: 'openrouter-model', default: 'anthropic/claude-sonnet-4-5' },
  { env: 'OPENAI_MODEL', cli: 'openai-model', default: 'gpt-5.4-mini' },
  { env: 'GEMINI_MODEL', cli: 'gemini-model', default: 'gemini-1.5-flash' },
  { env: 'GEMINI_PRICING_INPUT_PER_M', cli: 'gemini-pricing-input-per-m', default: '0', note: '(USD per 1M tokens)' },
  { env: 'GEMINI_PRICING_OUTPUT_PER_M', cli: 'gemini-pricing-output-per-m', default: '0', note: '(USD per 1M tokens)' },
  { env: 'BEDROCK_REGION', cli: 'bedrock-region', default: 'us-east-1' },
  { env: 'BEDROCK_MODEL_ID', cli: 'bedrock-model-id', default: '' },
  { env: 'BEDROCK_MAX_TOKENS', cli: 'bedrock-max-tokens', default: '1024' },
  { env: 'BEDROCK_PRICING_INPUT_PER_M', cli: 'bedrock-pricing-input-per-m', default: '0', note: '(USD per 1M tokens)' },
  { env: 'BEDROCK_PRICING_OUTPUT_PER_M', cli: 'bedrock-pricing-output-per-m', default: '0', note: '(USD per 1M tokens)' },
  { env: 'OLLAMA_BASE_URL', cli: 'ollama-base-url', default: 'http://host.docker.internal:11434', note: '(native runs: http://127.0.0.1:11434)' },
  { env: 'HEALTH_PORT', cli: 'health-port', default: '3001' },
  { env: 'HEALTH_BIND_HOST', cli: 'health-bind-host', default: '127.0.0.1' },
  { env: 'GITHUB_SPONSORS_URL', cli: 'github-sponsors-url', default: '' },
  { env: 'PATREON_URL', cli: 'patreon-url', default: '' },
  { env: 'KOFI_URL', cli: 'kofi-url', default: '' },
  { env: 'SUPPORT_CUSTOM_URL', cli: 'support-custom-url', default: '' },
  { env: 'SUPPORT_MESSAGE', cli: 'support-message', default: '' },
  { env: 'GITHUB_ISSUES_TOKEN', cli: 'github-issues-token', default: '', secret: true },
  { env: 'GITHUB_ISSUES_REPO', cli: 'github-issues-repo', default: 'owner/repo' },
  { env: 'MONITORING_TOKEN', cli: 'monitoring-token', default: '', secret: true },
  // Bridging (v3) — no interactive prompt flow; documented for manual setup
  // (docs/BRIDGING.md). All optional, default off.
  { env: 'BRIDGE_ENABLED', cli: 'bridge-enabled', default: '' },
  { env: 'INSTANCE_ID', cli: 'instance-id', default: '' },
  { env: 'BRIDGE_TRANSPORT', cli: 'bridge-transport', default: '' },
  { env: 'BRIDGE_BROKER_URL', cli: 'bridge-broker-url', default: '' },
  { env: 'BRIDGE_BROKER_USER', cli: 'bridge-broker-user', default: '' },
  { env: 'BRIDGE_BROKER_PASSWORD', cli: 'bridge-broker-password', default: '', secret: true },
  { env: 'BRIDGE_SUMMARY_INTERVAL_MINUTES', cli: 'bridge-summary-interval-minutes', default: '' },
  { env: 'BRIDGE_MAX_TEXT', cli: 'bridge-max-text', default: '' },
  { env: 'SHARED_MEMORY_ENABLED', cli: 'shared-memory-enabled', default: '' },
  { env: 'QDRANT_SHARED_COLLECTION', cli: 'qdrant-shared-collection', default: '' },
];

export const WHATSAPP_FIELDS = [
  { env: 'OWNER_JID', cli: 'owner-jid', default: 'your_number@s.whatsapp.net' },
  { env: 'BOT_PHONE_NUMBER', cli: 'bot-phone-number', default: '' },
  { env: 'WHATSAPP_LOGIN_MODE', cli: 'whatsapp-login-mode', default: 'web' },
  { env: 'WHATSAPP_LOGIN_TOKEN', cli: 'whatsapp-login-token', default: '', secret: true, note: '(gates only the WhatsApp browser-login page)' },
];

export const DISCORD_FIELDS = [
  { env: 'DISCORD_BOT_TOKEN', cli: 'discord-bot-token', default: '', secret: true },
  { env: 'DISCORD_PUBLIC_KEY', cli: 'discord-public-key', default: '' },
  { env: 'DISCORD_OWNER_ID', cli: 'discord-owner-id', default: '' },
  { env: 'DISCORD_GATEWAY_ENABLED', cli: 'discord-gateway-enabled', default: 'true' },
  { env: 'DISCORD_DIGEST_CHANNEL_ID', cli: 'discord-digest-channel-id', default: '' },
  { env: 'DISCORD_RECAP_CHANNEL_ID', cli: 'discord-recap-channel-id', default: '' },
  { env: 'BAND_FEATURES_ENABLED', cli: 'band-features-enabled', default: 'false' },
];

export const FIELD_TABLE = [
  ...SHARED_FIELDS,
  ...WHATSAPP_FIELDS,
  ...DISCORD_FIELDS,
];

export const NATIVE_RUN_DEFAULT_SHARED_KEYS = ['MESSAGING_PLATFORM'];

export const SHARED_LAYER_EXCEPTION_KEYS = [
  ...NATIVE_RUN_DEFAULT_SHARED_KEYS,
  'COMPOSE_PROFILES',
  'METRICS_ENABLED',
];

export const PLATFORM_LAYER_EXCEPTION_KEYS = {
  discord: ['DISCORD_CHANNELS_CONFIG_PATH', 'QDRANT_COLLECTION'],
  whatsapp: [],
  slack: [],
  teams: [],
};

const FIELD_BY_ENV = new Map(FIELD_TABLE.map((field) => [field.env, field]));

function envLine(values, key) {
  return `${key}=${values[key] ?? ''}`;
}

function envKeysFromLines(lines) {
  return lines
    .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
    .filter(Boolean);
}

export function buildSharedEnvLines(values) {
  return [
    '# Garbanzo generated by setup wizard (shared config — all platform instances)',
    '# Native-run default: docker compose pins this per service; harmless there.',
    ...NATIVE_RUN_DEFAULT_SHARED_KEYS.map((key) => envLine(values, key)),
    envLine(values, 'COMPOSE_PROFILES'),
    '',
    '# Cloud providers (runtime failover follows AI_PROVIDER_ORDER)',
    envLine(values, 'ANTHROPIC_API_KEY'),
    envLine(values, 'OPENROUTER_API_KEY'),
    envLine(values, 'OPENAI_API_KEY'),
    envLine(values, 'GEMINI_API_KEY'),
    envLine(values, 'AI_PROVIDER_ORDER'),
    envLine(values, 'ANTHROPIC_MODEL'),
    envLine(values, 'OPENROUTER_MODEL'),
    envLine(values, 'OPENAI_MODEL'),
    envLine(values, 'OPENAI_AUTH_MODE'),
    envLine(values, 'GEMINI_MODEL'),
    envLine(values, 'GEMINI_PRICING_INPUT_PER_M'),
    envLine(values, 'GEMINI_PRICING_OUTPUT_PER_M'),
    envLine(values, 'BEDROCK_REGION'),
    envLine(values, 'BEDROCK_MODEL_ID'),
    envLine(values, 'BEDROCK_MAX_TOKENS'),
    envLine(values, 'BEDROCK_PRICING_INPUT_PER_M'),
    envLine(values, 'BEDROCK_PRICING_OUTPUT_PER_M'),
    '',
    '# Optional feature APIs',
    envLine(values, 'GOOGLE_API_KEY'),
    envLine(values, 'MBTA_API_KEY'),
    envLine(values, 'NEWSAPI_KEY'),
    envLine(values, 'BRAVE_SEARCH_API_KEY'),
    '',
    '# Optional support links',
    envLine(values, 'GITHUB_SPONSORS_URL'),
    envLine(values, 'PATREON_URL'),
    envLine(values, 'KOFI_URL'),
    envLine(values, 'SUPPORT_CUSTOM_URL'),
    envLine(values, 'SUPPORT_MESSAGE'),
    envLine(values, 'GITHUB_ISSUES_TOKEN'),
    envLine(values, 'GITHUB_ISSUES_REPO'),
    '',
    '# Runtime',
    envLine(values, 'OLLAMA_BASE_URL'),
    envLine(values, 'LOG_LEVEL'),
    envLine(values, 'APP_VERSION'),
    envLine(values, 'HEALTH_PORT'),
    envLine(values, 'HEALTH_BIND_HOST'),
    envLine(values, 'SLACK_DEMO'),
    envLine(values, 'SLACK_DEMO_PORT'),
    envLine(values, 'SLACK_DEMO_BIND_HOST'),
    '',
    '# Monitoring (Prometheus + Grafana + /admin, /metrics gate)',
    envLine(values, 'METRICS_ENABLED'),
    envLine(values, 'MONITORING_TOKEN'),
    '',
    '# Bridging (v3) — cross-instance relay, default off (docs/BRIDGING.md)',
    envLine(values, 'BRIDGE_ENABLED'),
    envLine(values, 'INSTANCE_ID'),
    envLine(values, 'BRIDGE_TRANSPORT'),
    envLine(values, 'BRIDGE_BROKER_URL'),
    envLine(values, 'BRIDGE_BROKER_USER'),
    envLine(values, 'BRIDGE_BROKER_PASSWORD'),
    envLine(values, 'BRIDGE_SUMMARY_INTERVAL_MINUTES'),
    envLine(values, 'BRIDGE_MAX_TEXT'),
    envLine(values, 'SHARED_MEMORY_ENABLED'),
    envLine(values, 'QDRANT_SHARED_COLLECTION'),
    '',
  ];
}

export function buildPlatformEnvLines(platform, values) {
  if (platform === 'discord') {
    return [
      '# Garbanzo generated by setup wizard (Discord instance)',
      envLine(values, 'DISCORD_BOT_TOKEN'),
      envLine(values, 'DISCORD_PUBLIC_KEY'),
      envLine(values, 'DISCORD_OWNER_ID'),
      envLine(values, 'DISCORD_GATEWAY_ENABLED'),
      envLine(values, 'DISCORD_DIGEST_CHANNEL_ID'),
      envLine(values, 'DISCORD_RECAP_CHANNEL_ID'),
      envLine(values, 'DISCORD_CHANNELS_CONFIG_PATH'),
      '',
      '# Remy band memory',
      envLine(values, 'BAND_FEATURES_ENABLED'),
      envLine(values, 'QDRANT_COLLECTION'),
      '',
    ];
  }

  if (platform === 'whatsapp') {
    return [
      '# Garbanzo generated by setup wizard (WhatsApp instance)',
      envLine(values, 'OWNER_JID'),
      envLine(values, 'BOT_PHONE_NUMBER'),
      envLine(values, 'WHATSAPP_LOGIN_MODE'),
      envLine(values, 'WHATSAPP_LOGIN_TOKEN'),
      '',
    ];
  }

  return [];
}

export function getField(env) {
  const field = FIELD_BY_ENV.get(env);
  if (!field) throw new Error(`Unknown setup field: ${env}`);
  return field;
}

export const OPENAI_AUTH_MODES = ['apikey', 'oauth'];
export const WHATSAPP_LOGIN_MODES = ['web', 'terminal', 'both'];

/**
 * Non-interactive value for a field: CLI flag wins, then the existing .env
 * value, then the field default. Mirrors the prior ternary exactly.
 */
export function resolveEnvField(field, cli, existing) {
  return cli.options[field.cli] ?? existing[field.env] ?? field.default;
}

/**
 * The `[current]` hint shown in an interactive prompt. Secret fields show
 * `[set]`/`[empty]` and never the raw value, so keys don't leak to the terminal
 * (Sec-3). Non-secret fields show the current value or the default.
 */
export function promptHint(field, existing) {
  if (field.secret) {
    return existing[field.env] ? 'set' : 'empty';
  }
  return existing[field.env] ?? field.default;
}

export function mergeExistingEnvForPlatform(rootEnv, platformEnv = {}) {
  return { ...rootEnv, ...platformEnv };
}

export function promptFieldEnvsForPlatform(platform) {
  if (platform === 'discord') return DISCORD_FIELDS.map((field) => field.env);
  if (platform === 'whatsapp') return WHATSAPP_FIELDS.map((field) => field.env);
  return [];
}

export function emittedKeysForPlatform(platform) {
  return {
    sharedKeys: envKeysFromLines(buildSharedEnvLines({})),
    platformKeys: envKeysFromLines(buildPlatformEnvLines(platform, {})),
  };
}

export function redactEnvContent(content) {
  const redactPrefixes = [
    'ANTHROPIC_API_KEY=',
    'OPENROUTER_API_KEY=',
    'OPENAI_API_KEY=',
    'GEMINI_API_KEY=',
    'BEDROCK_MODEL_ID=',
    'GITHUB_ISSUES_TOKEN=',
    'MONITORING_TOKEN=',
    'WHATSAPP_LOGIN_TOKEN=',
    'DISCORD_BOT_TOKEN=',
    'OWNER_JID=',
    'BOT_PHONE_NUMBER=',
    'BRIDGE_BROKER_PASSWORD=',
  ];

  return content
    .split('\n')
    .map((line) => {
      const prefix = redactPrefixes.find((candidate) => line.startsWith(candidate));
      if (!prefix) return line;
      const value = line.slice(prefix.length).trim();
      return value ? `${prefix}[REDACTED]` : line;
    })
    .join('\n');
}

/**
 * Generates a fresh MONITORING_TOKEN: 24 random bytes as hex (48 chars).
 * Used by the wizard when monitoring is enabled and no token was supplied
 * via CLI flag or an existing .env — mirrors the per-run fallback in
 * src/index.ts, but persisted so it survives restarts and Prometheus/Grafana
 * (which need a stable, shared token) can be configured against it.
 */
export function generateMonitoringToken() {
  return randomBytes(24).toString('hex');
}

/**
 * Derives COMPOSE_PROFILES from the chosen platform and whether monitoring
 * was enabled. Pure so the four-combination matrix is unit-testable without
 * touching docker-compose.yml or spawning a real compose process.
 */
export function resolveComposeProfiles(platform, monitoringEnabled) {
  return monitoringEnabled ? `${platform},monitoring` : platform;
}

export const MESSAGING_PLATFORMS = ['discord', 'whatsapp', 'slack', 'teams'];
export const DEFAULT_MESSAGING_PLATFORM = 'discord';

/**
 * Non-interactive messaging platform resolution: CLI flag wins, then the
 * existing .env value, then the Discord-first default. Unrecognized values
 * fall back to the default rather than erroring, mirroring the prior inline
 * ternary in setup.mjs.
 */
export function resolveMessagingPlatform(cli, existing) {
  const requested = (cli.options.platform || existing.MESSAGING_PLATFORM || DEFAULT_MESSAGING_PLATFORM)
    .trim()
    .toLowerCase();
  return MESSAGING_PLATFORMS.includes(requested) ? requested : DEFAULT_MESSAGING_PLATFORM;
}
