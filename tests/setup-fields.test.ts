// Unit tests for the setup wizard's field table + resolvers. The module is pure
// (no config import), so no env prefix is needed. tsconfig excludes tests/, so
// importing the TypeScript source keeps repo-dev tests independent of dist/.
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DISCORD_FIELDS,
  SHARED_FIELDS,
  WHATSAPP_FIELDS,
  TELEGRAM_FIELDS,
  MATRIX_FIELDS,
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
  mergeEnvFileContent,
  buildPlatformEnvLines,
  buildSharedEnvLines,
  redactEnvContent,
  promptFieldEnvsForPlatform,
  emittedKeysForPlatform,
  SHARED_LAYER_EXCEPTION_KEYS,
  PLATFORM_LAYER_EXCEPTION_KEYS,
  NATIVE_RUN_DEFAULT_SHARED_KEYS,
} from '../src/config-core/fields.js';
import { writeFileWithBackupAtomic } from '../src/config-core/writers.js';

function cli(options: Record<string, string>): { options: Record<string, string>; flags: Set<string> } {
  return { options, flags: new Set<string>() };
}

function envKeysFromLines(lines: string[]): string[] {
  return lines
    .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
    .filter((key): key is string => Boolean(key));
}

describe('setup field resolver', () => {
  it('replaces files atomically while preserving the previous bytes in .bak', () => {
    const dir = mkdtempSync(join(tmpdir(), 'garbanzo-config-writer-'));
    const path = join(dir, '.env');
    try {
      writeFileSync(path, 'OPERATOR_ONLY=before\n', 'utf8');
      writeFileWithBackupAtomic(path, 'OPERATOR_ONLY=after\n');

      expect(readFileSync(path, 'utf8')).toBe('OPERATOR_ONLY=after\n');
      expect(readFileSync(`${path}.bak`, 'utf8')).toBe('OPERATOR_ONLY=before\n');
      expect(readdirSync(dir).some((entry) => entry.endsWith('.tmp'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the exact target mode of a non-credential file even when the umask would mask it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'garbanzo-config-writer-mode-'));
    // A config/*.json file (container-read, mode preserved) proves the
    // chmod-after-write defeats the umask; a .env is instead forced to 0o600
    // by the credential policy (asserted below).
    const path = join(dir, 'discord-channels.json');
    const previousUmask = process.umask(0o022);
    try {
      writeFileSync(path, 'before\n', 'utf8');
      chmodSync(path, 0o666);

      writeFileWithBackupAtomic(path, 'after\n');

      expect(statSync(path).mode & 0o777).toBe(0o666);
    } finally {
      process.umask(previousUmask);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forces credential files (.env*) to owner-only and never leaks via the backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'garbanzo-config-writer-secret-'));
    const previousUmask = process.umask(0o022);
    try {
      // New credential file → owner-only, not the 0o644 config default.
      const fresh = join(dir, '.env');
      writeFileWithBackupAtomic(fresh, 'OPENAI_API_KEY=secret\n');
      expect(statSync(fresh).mode & 0o777).toBe(0o600);

      // An already world-readable .env is tightened on rewrite, and its backup
      // is never world-readable regardless of the original mode.
      const loose = join(dir, '.env.discord');
      writeFileSync(loose, 'DISCORD_BOT_TOKEN=old\n', 'utf8');
      chmodSync(loose, 0o644);
      writeFileWithBackupAtomic(loose, 'DISCORD_BOT_TOKEN=new\n');
      expect(statSync(loose).mode & 0o777).toBe(0o600);
      expect(statSync(`${loose}.bak`).mode & 0o777).toBe(0o600);

      // New config/*.json stays container-readable (0o644) so the bind-mounted
      // file remains readable by the container's differing uid.
      const cfg = join(dir, 'groups.json');
      writeFileWithBackupAtomic(cfg, '{}\n');
      expect(statSync(cfg).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(previousUmask);
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
    for (const env of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GITHUB_ISSUES_TOKEN', 'DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN']) {
      expect(getField(env).secret).toBe(true);
    }
    expect(getField('OPENAI_MODEL').secret).toBe(false);
  });

  it('exposes Telegram setup fields separately from the always-collected fields', () => {
    expect(TELEGRAM_FIELDS.map((field) => field.env)).toEqual([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_OWNER_ID',
      'TELEGRAM_CHAT_SCOPE',
    ]);
  });

  it('resolves Telegram fields from cli, existing env, then defaults', () => {
    const token = getField('TELEGRAM_BOT_TOKEN');
    expect(resolveEnvField(token, cli({ 'telegram-bot-token': 'cli-token' }), { TELEGRAM_BOT_TOKEN: 'existing-token' })).toBe('cli-token');
    expect(resolveEnvField(token, cli({}), { TELEGRAM_BOT_TOKEN: 'existing-token' })).toBe('existing-token');
    expect(resolveEnvField(token, cli({}), {})).toBe('');

    const ownerId = getField('TELEGRAM_OWNER_ID');
    expect(resolveEnvField(ownerId, cli({ 'telegram-owner-id': 'cli-owner' }), { TELEGRAM_OWNER_ID: 'existing-owner' })).toBe('cli-owner');

    const chatScope = getField('TELEGRAM_CHAT_SCOPE');
    expect(resolveEnvField(chatScope, cli({}), {})).toBe('configured');
    expect(promptHint(token, { TELEGRAM_BOT_TOKEN: 'telegram-secret-token' })).toBe('set');
    expect(promptHint(token, {})).toBe('empty');
    expect(promptHint(token, { TELEGRAM_BOT_TOKEN: 'telegram-secret-token' })).not.toContain('telegram-secret-token');
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

  it('partitions every emitted field into exactly one of SHARED/WHATSAPP/DISCORD/TELEGRAM/MATRIX_FIELDS', () => {
    const sharedKeys = SHARED_FIELDS.map((f) => f.env);
    const whatsappKeys = WHATSAPP_FIELDS.map((f) => f.env);
    const discordKeys = DISCORD_FIELDS.map((f) => f.env);
    const telegramKeys = TELEGRAM_FIELDS.map((f) => f.env);
    const matrixKeys = MATRIX_FIELDS.map((f) => f.env);
    const allKeys = [...sharedKeys, ...whatsappKeys, ...discordKeys, ...telegramKeys, ...matrixKeys];

    // No duplicates across the four lists (disjoint partition).
    expect(new Set(allKeys).size).toBe(allKeys.length);

    // Spot-check expected homes for a few keys per the brief.
    expect(sharedKeys).not.toContain('OWNER_JID');
    expect(sharedKeys).not.toContain('BOT_PHONE_NUMBER');
    expect(whatsappKeys).toEqual(expect.arrayContaining(['OWNER_JID', 'BOT_PHONE_NUMBER']));
    expect(discordKeys).toContain('DISCORD_BOT_TOKEN');
    expect(telegramKeys).toContain('TELEGRAM_BOT_TOKEN');
    expect(matrixKeys).toContain('MATRIX_ACCESS_TOKEN');

    // FIELD_TABLE is exactly the union of the four partitioned lists.
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

  it('merges generated env content into existing files without dropping unknown keys or comments', () => {
    const generatedContent = [
      '# generated header',
      'MESSAGING_PLATFORM=whatsapp',
      '',
      '# models',
      'OPENAI_MODEL=gpt-updated',
      'ANTHROPIC_MODEL=claude-haiku-4-5-20251001',
      '',
    ].join('\n');
    const existingContent = [
      '# operator note',
      'MESSAGING_PLATFORM=discord',
      'OPERATOR_ONLY=keep-me',
      'OPENAI_MODEL=old-model',
      '',
    ].join('\n');

    const merged = mergeEnvFileContent(existingContent, generatedContent);

    expect(merged).toContain('# operator note');
    expect(merged).toMatch(/^OPERATOR_ONLY=keep-me$/m);
    expect(merged).toMatch(/^MESSAGING_PLATFORM=whatsapp$/m);
    expect(merged).toMatch(/^OPENAI_MODEL=gpt-updated$/m);
    expect(merged).toMatch(/^ANTHROPIC_MODEL=claude-haiku-4-5-20251001$/m);
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

  it('redacts MATRIX_ACCESS_TOKEN in dry-run env previews', () => {
    const redacted = redactEnvContent([
      'MATRIX_HOMESERVER_URL=https://matrix.example.org',
      'MATRIX_ACCESS_TOKEN=real-matrix-access-token',
      'MATRIX_ACCESS_TOKEN=',
    ].join('\n'));

    expect(redacted).toContain('MATRIX_ACCESS_TOKEN=[REDACTED]');
    expect(redacted).not.toContain('real-matrix-access-token');
    expect(redacted).toContain('MATRIX_HOMESERVER_URL=https://matrix.example.org');
    expect(redacted).toContain('MATRIX_ACCESS_TOKEN=');
  });

  it('does not collect WhatsApp prompt fields for the Discord setup path', () => {
    expect(promptFieldEnvsForPlatform('discord')).toEqual(DISCORD_FIELDS.map((field) => field.env));
    expect(promptFieldEnvsForPlatform('discord')).not.toEqual(expect.arrayContaining(
      WHATSAPP_FIELDS.map((field) => field.env),
    ));
    expect(promptFieldEnvsForPlatform('whatsapp')).toEqual(WHATSAPP_FIELDS.map((field) => field.env));
    expect(promptFieldEnvsForPlatform('telegram')).toEqual(TELEGRAM_FIELDS.map((field) => field.env));
  });

  it('builds and partitions the actual emitted env line sets from one source', () => {
    const sharedKeys = envKeysFromLines(buildSharedEnvLines({}));
    const discordPlatformKeys = envKeysFromLines(buildPlatformEnvLines('discord', {}));
    const whatsappPlatformKeys = envKeysFromLines(buildPlatformEnvLines('whatsapp', {}));
    const telegramPlatformKeys = envKeysFromLines(buildPlatformEnvLines('telegram', {}));
    const discordKeys = emittedKeysForPlatform('discord');
    const whatsappKeys = emittedKeysForPlatform('whatsapp');
    const telegramKeys = emittedKeysForPlatform('telegram');

    expect(new Set(discordKeys.sharedKeys).size).toBe(discordKeys.sharedKeys.length);
    expect(new Set(discordKeys.platformKeys).size).toBe(discordKeys.platformKeys.length);
    expect(new Set(whatsappKeys.platformKeys).size).toBe(whatsappKeys.platformKeys.length);
    expect(new Set(telegramKeys.platformKeys).size).toBe(telegramKeys.platformKeys.length);
    expect(discordKeys.sharedKeys).toEqual(sharedKeys);
    expect(whatsappKeys.sharedKeys).toEqual(sharedKeys);
    expect(telegramKeys.sharedKeys).toEqual(sharedKeys);
    expect(discordKeys.platformKeys).toEqual(discordPlatformKeys);
    expect(whatsappKeys.platformKeys).toEqual(whatsappPlatformKeys);
    expect(telegramKeys.platformKeys).toEqual(telegramPlatformKeys);

    const discordIntersection = discordKeys.sharedKeys.filter((key) => discordKeys.platformKeys.includes(key));
    const whatsappIntersection = whatsappKeys.sharedKeys.filter((key) => whatsappKeys.platformKeys.includes(key));
    const telegramIntersection = telegramKeys.sharedKeys.filter((key) => telegramKeys.platformKeys.includes(key));
    expect(discordIntersection).toEqual([]);
    expect(whatsappIntersection).toEqual([]);
    expect(telegramIntersection).toEqual([]);

    expect(NATIVE_RUN_DEFAULT_SHARED_KEYS).toEqual(['MESSAGING_PLATFORM']);
    expect(SHARED_LAYER_EXCEPTION_KEYS).toEqual(expect.arrayContaining([
      'MESSAGING_PLATFORM',
      'COMPOSE_PROFILES',
      'METRICS_ENABLED',
    ]));
    expect(PLATFORM_LAYER_EXCEPTION_KEYS.discord).toContain('QDRANT_COLLECTION');
    expect(PLATFORM_LAYER_EXCEPTION_KEYS.telegram).toContain('TELEGRAM_CHATS_CONFIG_PATH');

    for (const key of [...SHARED_FIELDS.map((field) => field.env), ...SHARED_LAYER_EXCEPTION_KEYS]) {
      expect(discordKeys.sharedKeys).toContain(key);
      expect(whatsappKeys.sharedKeys).toContain(key);
      expect(telegramKeys.sharedKeys).toContain(key);
    }
    for (const key of WHATSAPP_FIELDS.map((field) => field.env)) {
      expect(whatsappKeys.platformKeys).toContain(key);
      expect(discordKeys.sharedKeys).not.toContain(key);
    }
    for (const key of DISCORD_FIELDS.map((field) => field.env)) {
      expect(discordKeys.platformKeys).toContain(key);
      expect(whatsappKeys.sharedKeys).not.toContain(key);
    }
    for (const key of TELEGRAM_FIELDS.map((field) => field.env)) {
      expect(telegramKeys.platformKeys).toContain(key);
      expect(discordKeys.sharedKeys).not.toContain(key);
    }

    const sharedPreview = buildSharedEnvLines({ MONITORING_TOKEN: 'real-generated-monitoring-token' }).join('\n');
    expect(redactEnvContent(sharedPreview)).toContain('MONITORING_TOKEN=[REDACTED]');
    expect(redactEnvContent(sharedPreview)).not.toContain('real-generated-monitoring-token');
  });

  it('has the setup wizard emit env files through the shared line builders', () => {
    const setupSource = readFileSync(new URL('../src/cli/setup/run.ts', import.meta.url), 'utf-8');

    expect(setupSource).toMatch(/buildSharedEnvLines\(finalEnv\)\.join\('\\n'\)/);
    expect(setupSource).toMatch(/buildPlatformEnvLines\('discord', finalEnv\)\.join\('\\n'\)/);
    expect(setupSource).toMatch(/buildPlatformEnvLines\('whatsapp', finalEnv\)\.join\('\\n'\)/);
    expect(setupSource).toMatch(/buildPlatformEnvLines\('telegram', finalEnv\)\.join\('\\n'\)/);
  });

  it('resolves the non-interactive messaging platform with a discord default', () => {
    expect(DEFAULT_MESSAGING_PLATFORM).toBe('discord');
    expect(resolveMessagingPlatform(cli({}), {})).toBe('discord');
    expect(resolveMessagingPlatform(cli({ platform: 'whatsapp' }), {})).toBe('whatsapp');
    expect(resolveMessagingPlatform(cli({}), { MESSAGING_PLATFORM: 'whatsapp' })).toBe('whatsapp');
    expect(resolveMessagingPlatform(cli({ platform: 'telegram' }), {})).toBe('telegram');
  });

  it('rejects explicit platform values the wizard does not support instead of silently defaulting', () => {
    expect(() => resolveMessagingPlatform(cli({ platform: 'teams' }), {})).toThrow(/Unsupported platform "teams"/);
    expect(resolveMessagingPlatform(cli({ platform: 'matrix' }), {})).toBe('matrix');
    expect(() => resolveMessagingPlatform(cli({ platform: 'not-a-platform' }), {})).toThrow(/Unsupported platform/);
    // An existing .env carrying a removed platform must also fail loudly, not migrate silently
    expect(() => resolveMessagingPlatform(cli({}), { MESSAGING_PLATFORM: 'teams' })).toThrow(/Unsupported platform "teams"/);
  });
});
