import { z } from 'zod';
import { booleanFromEnv, optionalString } from './shared.js';

export const discordSchema = z.object({
  // Slack runtime
  SLACK_BOT_TOKEN: optionalString,
  SLACK_SIGNING_SECRET: optionalString,
  SLACK_BOT_USER_ID: optionalString,
  // Optional token rotation support (recommended for expiring Slack tokens)
  SLACK_CLIENT_ID: optionalString,
  SLACK_CLIENT_SECRET: optionalString,
  SLACK_REFRESH_TOKEN: optionalString,
  SLACK_TOKEN_STATE_FILE: z.string().default('data/slack-token-state.json'),
  SLACK_TOKEN_ROTATE_MIN_BUFFER: z.coerce.number().int().min(1).max(120).default(5),
  SLACK_EVENTS_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  SLACK_EVENTS_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  // Slack demo runtime (non-production)
  SLACK_DEMO: booleanFromEnv.default(false),
  SLACK_DEMO_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  SLACK_DEMO_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  DEMO_TURNSTILE_ENABLED: booleanFromEnv.default(false),
  DEMO_TURNSTILE_SITE_KEY: optionalString,
  DEMO_TURNSTILE_SECRET_KEY: optionalString,

  // Discord runtime
  DISCORD_BOT_TOKEN: optionalString,
  DISCORD_PUBLIC_KEY: optionalString,
  DISCORD_OWNER_ID: optionalString,
  DISCORD_GATEWAY_ENABLED: booleanFromEnv.default(true),
  DISCORD_DIGEST_CHANNEL_ID: optionalString,
  DISCORD_RECAP_CHANNEL_ID: optionalString,
  DISCORD_PRACTICE_CHANNEL_ID: optionalString,
  DISCORD_CHANNELS_CONFIG_PATH: z.string().default('config/discord-channels.json'),
  DISCORD_INTERACTIONS_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  DISCORD_INTERACTIONS_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  // Discord demo runtime (non-production)
  DISCORD_DEMO: booleanFromEnv.default(false),
  DISCORD_DEMO_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  DISCORD_DEMO_BIND_HOST: z.string().min(1).default('127.0.0.1'),
});
