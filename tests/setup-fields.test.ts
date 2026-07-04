// Unit tests for the setup wizard's field table + resolvers. The module is pure
// (no config import), so no env prefix is needed. tsconfig excludes tests/, so
// importing the .mjs here is fine.
import { describe, expect, it } from 'vitest';

import {
  DISCORD_FIELDS,
  getField,
  promptHint,
  resolveEnvField,
  OPENAI_AUTH_MODES,
  WHATSAPP_LOGIN_MODES,
} from '../scripts/setup-fields.mjs';

function cli(options: Record<string, string>): { options: Record<string, string>; flags: Set<string> } {
  return { options, flags: new Set<string>() };
}

describe('setup field resolver', () => {
  it('resolves non-interactive values with cli > existing > default precedence', () => {
    const field = getField('OPENAI_MODEL');
    expect(resolveEnvField(field, cli({ 'openai-model': 'gpt-x' }), { OPENAI_MODEL: 'existing' })).toBe('gpt-x');
    expect(resolveEnvField(field, cli({}), { OPENAI_MODEL: 'existing' })).toBe('existing');
    expect(resolveEnvField(field, cli({}), {})).toBe('gpt-5.4-mini');
  });

  it('masks secret fields in prompt hints, never showing the raw value', () => {
    const secret = getField('OPENAI_API_KEY');
    expect(secret.secret).toBe(true);
    expect(promptHint(secret, { OPENAI_API_KEY: 'sk-super-secret' })).toBe('set');
    expect(promptHint(secret, {})).toBe('empty');
    expect(promptHint(secret, { OPENAI_API_KEY: 'sk-super-secret' })).not.toContain('sk-');
  });

  it('shows the current value or default for non-secret fields', () => {
    const model = getField('OPENAI_MODEL');
    expect(promptHint(model, { OPENAI_MODEL: 'gpt-9' })).toBe('gpt-9');
    expect(promptHint(model, {})).toBe('gpt-5.4-mini');
  });

  it('marks every API key/token field as secret', () => {
    for (const env of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GITHUB_ISSUES_TOKEN', 'DISCORD_BOT_TOKEN']) {
      expect(getField(env).secret).toBe(true);
    }
    expect(getField('OPENAI_MODEL').secret).toBeUndefined();
  });

  it('exposes Discord setup fields separately from the always-collected fields', () => {
    expect(DISCORD_FIELDS.map((field) => field.env)).toEqual([
      'DISCORD_BOT_TOKEN',
      'DISCORD_PUBLIC_KEY',
      'DISCORD_OWNER_ID',
      'DISCORD_GATEWAY_ENABLED',
      'DISCORD_DIGEST_CHANNEL_ID',
      'DISCORD_RECAP_CHANNEL_ID',
      'BAND_FEATURES_ENABLED',
    ]);
  });

  it('resolves Discord fields from cli, existing env, then defaults', () => {
    const token = getField('DISCORD_BOT_TOKEN');
    expect(resolveEnvField(token, cli({ 'discord-bot-token': 'cli-token' }), { DISCORD_BOT_TOKEN: 'existing-token' })).toBe('cli-token');
    expect(resolveEnvField(token, cli({}), { DISCORD_BOT_TOKEN: 'existing-token' })).toBe('existing-token');
    expect(resolveEnvField(token, cli({}), {})).toBe('');

    const publicKey = getField('DISCORD_PUBLIC_KEY');
    expect(resolveEnvField(publicKey, cli({ 'discord-public-key': 'cli-public' }), { DISCORD_PUBLIC_KEY: 'existing-public' })).toBe('cli-public');

    const ownerId = getField('DISCORD_OWNER_ID');
    expect(resolveEnvField(ownerId, cli({ 'discord-owner-id': 'cli-owner' }), { DISCORD_OWNER_ID: 'existing-owner' })).toBe('cli-owner');

    const digestChannelId = getField('DISCORD_DIGEST_CHANNEL_ID');
    expect(resolveEnvField(digestChannelId, cli({ 'discord-digest-channel-id': 'cli-digest' }), { DISCORD_DIGEST_CHANNEL_ID: 'existing-digest' })).toBe('cli-digest');

    const recapChannelId = getField('DISCORD_RECAP_CHANNEL_ID');
    expect(resolveEnvField(recapChannelId, cli({ 'discord-recap-channel-id': 'cli-recap' }), { DISCORD_RECAP_CHANNEL_ID: 'existing-recap' })).toBe('cli-recap');
  });

  it('uses Discord/Remy defaults and masks the Discord bot token prompt hint', () => {
    const token = getField('DISCORD_BOT_TOKEN');
    expect(token.secret).toBe(true);
    expect(promptHint(token, { DISCORD_BOT_TOKEN: 'discord-secret-token' })).toBe('set');
    expect(promptHint(token, {})).toBe('empty');
    expect(promptHint(token, { DISCORD_BOT_TOKEN: 'discord-secret-token' })).not.toContain('discord-secret-token');

    expect(resolveEnvField(getField('DISCORD_GATEWAY_ENABLED'), cli({}), {})).toBe('true');
    expect(resolveEnvField(getField('BAND_FEATURES_ENABLED'), cli({}), {})).toBe('false');
  });

  it('exposes the new auth/login mode enums and rejects unknown fields', () => {
    expect(OPENAI_AUTH_MODES).toEqual(['apikey', 'oauth']);
    expect(WHATSAPP_LOGIN_MODES).toEqual(['web', 'terminal', 'both']);
    expect(() => getField('NOPE')).toThrow(/Unknown setup field/);
  });
});
