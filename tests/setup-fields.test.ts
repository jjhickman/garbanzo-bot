// Unit tests for the setup wizard's field table + resolvers. The module is pure
// (no config import), so no env prefix is needed. tsconfig excludes tests/, so
// importing the .mjs here is fine.
import { describe, expect, it } from 'vitest';

import {
  DISCORD_FIELDS,
  SHARED_FIELDS,
  WHATSAPP_FIELDS,
  FIELD_TABLE,
  getField,
  promptHint,
  resolveEnvField,
  OPENAI_AUTH_MODES,
  WHATSAPP_LOGIN_MODES,
  generateMonitoringToken,
  resolveComposeProfiles,
  resolveMessagingPlatform,
  DEFAULT_MESSAGING_PLATFORM,
  mergeExistingEnvForPlatform,
  redactEnvContent,
  promptFieldEnvsForPlatform,
  emittedKeysForPlatform,
  SHARED_LAYER_EXCEPTION_KEYS,
  PLATFORM_LAYER_EXCEPTION_KEYS,
  NATIVE_RUN_DEFAULT_SHARED_KEYS,
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

  it('adds a secret-masked MONITORING_TOKEN field to the shared field list', () => {
    const field = getField('MONITORING_TOKEN');
    expect(field.secret).toBe(true);
    expect(SHARED_FIELDS.map((f) => f.env)).toContain('MONITORING_TOKEN');
    expect(promptHint(field, { MONITORING_TOKEN: 'super-secret-token' })).toBe('set');
    expect(promptHint(field, {})).toBe('empty');
    expect(promptHint(field, { MONITORING_TOKEN: 'super-secret-token' })).not.toContain('super-secret-token');
  });

  it('generateMonitoringToken returns a 48-character hex string, freshly random each call', () => {
    const first = generateMonitoringToken();
    const second = generateMonitoringToken();
    expect(first).toMatch(/^[0-9a-f]{48}$/);
    expect(second).toMatch(/^[0-9a-f]{48}$/);
    expect(first).not.toBe(second);
  });

  it('resolveComposeProfiles derives COMPOSE_PROFILES from platform + monitoring toggle', () => {
    expect(resolveComposeProfiles('discord', true)).toBe('discord,monitoring');
    expect(resolveComposeProfiles('discord', false)).toBe('discord');
    expect(resolveComposeProfiles('whatsapp', true)).toBe('whatsapp,monitoring');
    expect(resolveComposeProfiles('whatsapp', false)).toBe('whatsapp');
  });

  it('partitions every emitted field into exactly one of SHARED/WHATSAPP/DISCORD_FIELDS', () => {
    const sharedKeys = SHARED_FIELDS.map((f) => f.env);
    const whatsappKeys = WHATSAPP_FIELDS.map((f) => f.env);
    const discordKeys = DISCORD_FIELDS.map((f) => f.env);
    const allKeys = [...sharedKeys, ...whatsappKeys, ...discordKeys];

    // No duplicates across the three lists (disjoint partition).
    expect(new Set(allKeys).size).toBe(allKeys.length);

    // Spot-check expected homes for a few keys per the brief.
    expect(sharedKeys).not.toContain('OWNER_JID');
    expect(sharedKeys).not.toContain('BOT_PHONE_NUMBER');
    expect(whatsappKeys).toEqual(expect.arrayContaining(['OWNER_JID', 'BOT_PHONE_NUMBER']));
    expect(discordKeys).toContain('DISCORD_BOT_TOKEN');

    // FIELD_TABLE is exactly the union of the three partitioned lists.
    expect(FIELD_TABLE.map((f) => f.env).sort()).toEqual(allKeys.slice().sort());
  });

  it('merges root and selected platform env values with platform values winning', () => {
    expect(
      mergeExistingEnvForPlatform(
        {
          OPENAI_MODEL: 'root-model',
          DISCORD_BOT_TOKEN: 'root-discord-token',
          OWNER_JID: 'root-owner@s.whatsapp.net',
        },
        {
          DISCORD_BOT_TOKEN: 'platform-discord-token',
          DISCORD_OWNER_ID: 'platform-owner',
        },
      ),
    ).toEqual({
      OPENAI_MODEL: 'root-model',
      DISCORD_BOT_TOKEN: 'platform-discord-token',
      OWNER_JID: 'root-owner@s.whatsapp.net',
      DISCORD_OWNER_ID: 'platform-owner',
    });
  });

  it('redacts MONITORING_TOKEN in dry-run env previews', () => {
    const redacted = redactEnvContent([
      'MONITORING_TOKEN=real-generated-monitoring-token',
      'OPENAI_MODEL=gpt-5.4-mini',
      'DISCORD_BOT_TOKEN=real-discord-token',
      'MONITORING_TOKEN=',
    ].join('\n'));

    expect(redacted).toContain('MONITORING_TOKEN=[REDACTED]');
    expect(redacted).not.toContain('real-generated-monitoring-token');
    expect(redacted).toContain('OPENAI_MODEL=gpt-5.4-mini');
    expect(redacted).toContain('DISCORD_BOT_TOKEN=[REDACTED]');
    expect(redacted).toContain('MONITORING_TOKEN=');
  });

  it('does not collect WhatsApp prompt fields for the Discord setup path', () => {
    expect(promptFieldEnvsForPlatform('discord')).toEqual(DISCORD_FIELDS.map((field) => field.env));
    expect(promptFieldEnvsForPlatform('discord')).not.toEqual(expect.arrayContaining(
      WHATSAPP_FIELDS.map((field) => field.env),
    ));
    expect(promptFieldEnvsForPlatform('whatsapp')).toEqual(WHATSAPP_FIELDS.map((field) => field.env));
  });

  it('documents and partitions the actual emitted env key sets', () => {
    const discordKeys = emittedKeysForPlatform('discord');
    const whatsappKeys = emittedKeysForPlatform('whatsapp');

    expect(new Set(discordKeys.sharedKeys).size).toBe(discordKeys.sharedKeys.length);
    expect(new Set(discordKeys.platformKeys).size).toBe(discordKeys.platformKeys.length);
    expect(new Set(whatsappKeys.platformKeys).size).toBe(whatsappKeys.platformKeys.length);

    const discordIntersection = discordKeys.sharedKeys.filter((key) => discordKeys.platformKeys.includes(key));
    const whatsappIntersection = whatsappKeys.sharedKeys.filter((key) => whatsappKeys.platformKeys.includes(key));
    expect(discordIntersection).toEqual([]);
    expect(whatsappIntersection).toEqual([]);

    expect(NATIVE_RUN_DEFAULT_SHARED_KEYS).toEqual(['MESSAGING_PLATFORM']);
    expect(SHARED_LAYER_EXCEPTION_KEYS).toEqual(expect.arrayContaining([
      'MESSAGING_PLATFORM',
      'COMPOSE_PROFILES',
      'METRICS_ENABLED',
    ]));
    expect(PLATFORM_LAYER_EXCEPTION_KEYS.discord).toContain('QDRANT_COLLECTION');

    for (const key of [...SHARED_FIELDS.map((field) => field.env), ...SHARED_LAYER_EXCEPTION_KEYS]) {
      expect(discordKeys.sharedKeys).toContain(key);
      expect(whatsappKeys.sharedKeys).toContain(key);
    }
    for (const key of WHATSAPP_FIELDS.map((field) => field.env)) {
      expect(whatsappKeys.platformKeys).toContain(key);
      expect(discordKeys.sharedKeys).not.toContain(key);
    }
    for (const key of DISCORD_FIELDS.map((field) => field.env)) {
      expect(discordKeys.platformKeys).toContain(key);
      expect(whatsappKeys.sharedKeys).not.toContain(key);
    }
  });

  it('resolves the non-interactive messaging platform with a discord default', () => {
    expect(DEFAULT_MESSAGING_PLATFORM).toBe('discord');
    expect(resolveMessagingPlatform(cli({}), {})).toBe('discord');
    expect(resolveMessagingPlatform(cli({ platform: 'whatsapp' }), {})).toBe('whatsapp');
    expect(resolveMessagingPlatform(cli({}), { MESSAGING_PLATFORM: 'whatsapp' })).toBe('whatsapp');
    expect(resolveMessagingPlatform(cli({ platform: 'not-a-platform' }), {})).toBe('discord');
  });
});
