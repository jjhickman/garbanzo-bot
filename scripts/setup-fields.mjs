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
 */
export const FIELD_TABLE = [
  { env: 'ANTHROPIC_API_KEY', cli: 'anthropic-key', default: '', secret: true },
  { env: 'OPENROUTER_API_KEY', cli: 'openrouter-key', default: '', secret: true },
  { env: 'OPENAI_API_KEY', cli: 'openai-key', default: '', secret: true },
  { env: 'GEMINI_API_KEY', cli: 'gemini-key', default: '', secret: true },
  { env: 'ANTHROPIC_MODEL', cli: 'anthropic-model', default: 'claude-sonnet-4-5-20250514' },
  { env: 'OPENROUTER_MODEL', cli: 'openrouter-model', default: 'anthropic/claude-sonnet-4-5' },
  { env: 'OPENAI_MODEL', cli: 'openai-model', default: 'gpt-4.1' },
  { env: 'GEMINI_MODEL', cli: 'gemini-model', default: 'gemini-1.5-flash' },
  { env: 'GEMINI_PRICING_INPUT_PER_M', cli: 'gemini-pricing-input-per-m', default: '0', note: '(USD per 1M tokens)' },
  { env: 'GEMINI_PRICING_OUTPUT_PER_M', cli: 'gemini-pricing-output-per-m', default: '0', note: '(USD per 1M tokens)' },
  { env: 'BEDROCK_REGION', cli: 'bedrock-region', default: 'us-east-1' },
  { env: 'BEDROCK_MODEL_ID', cli: 'bedrock-model-id', default: '' },
  { env: 'BEDROCK_MAX_TOKENS', cli: 'bedrock-max-tokens', default: '1024' },
  { env: 'BEDROCK_PRICING_INPUT_PER_M', cli: 'bedrock-pricing-input-per-m', default: '0', note: '(USD per 1M tokens)' },
  { env: 'BEDROCK_PRICING_OUTPUT_PER_M', cli: 'bedrock-pricing-output-per-m', default: '0', note: '(USD per 1M tokens)' },
  { env: 'OLLAMA_BASE_URL', cli: 'ollama-base-url', default: 'http://127.0.0.1:11434' },
  { env: 'OWNER_JID', cli: 'owner-jid', default: 'your_number@s.whatsapp.net' },
  { env: 'HEALTH_PORT', cli: 'health-port', default: '3001' },
  { env: 'HEALTH_BIND_HOST', cli: 'health-bind-host', default: '127.0.0.1' },
  { env: 'GITHUB_SPONSORS_URL', cli: 'github-sponsors-url', default: '' },
  { env: 'PATREON_URL', cli: 'patreon-url', default: '' },
  { env: 'KOFI_URL', cli: 'kofi-url', default: '' },
  { env: 'SUPPORT_CUSTOM_URL', cli: 'support-custom-url', default: '' },
  { env: 'SUPPORT_MESSAGE', cli: 'support-message', default: '' },
  { env: 'GITHUB_ISSUES_TOKEN', cli: 'github-issues-token', default: '', secret: true },
  { env: 'GITHUB_ISSUES_REPO', cli: 'github-issues-repo', default: 'owner/repo' },
];

const FIELD_BY_ENV = new Map(FIELD_TABLE.map((field) => [field.env, field]));

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
