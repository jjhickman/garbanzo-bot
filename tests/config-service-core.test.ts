import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { appendConfigAudit } from '../src/cli/config-service/audit.js';
import {
  applyStagedBundle,
  bundlePreconditionsMatch,
  buildExportBundle,
  captureBundlePreconditions,
  IMPORT_LIMITS,
  restoreJsonPlaceholders,
  validateBundleLimits,
} from '../src/cli/config-service/bundle.js';
import { parseConfig } from '../src/utils/config/parse-config.js';
import { parse as parseDotenv } from 'dotenv';
import { runWizard } from '../src/cli/config-service/wizard.js';
import { readEnvSnapshot, writeEnvUpdate } from '../src/cli/config-service/env-files.js';

describe('config service core operations', () => {
  const roots: string[] = [];
  const tempRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'garbanzo-config-core-'));
    roots.push(root);
    return root;
  };

  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it('exports only secret-masked config content and audits secret changes safely', () => {
    const root = tempRoot();
    const canary = 'config_export_canary_4d77';
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, '.env'), `MESSAGING_PLATFORM=discord\nOPENAI_API_KEY=${canary}\n`);
    writeFileSync(join(root, 'config', 'rag-sources.json'), JSON.stringify({ sources: [{
      id: 'one', label: 'One', apiKey: canary, collection: 'facts', embedding: { provider: 'openai' },
    }] }));
    appendConfigAudit(root, {
      action: 'test', target: 'env', changes: [{ key: 'OPENAI_API_KEY', before: 'old', after: canary }],
    });

    expect(JSON.stringify(buildExportBundle(root))).not.toContain(canary);
    expect(readFileSync(join(root, 'data', 'config-audit.jsonl'), 'utf8')).not.toContain(canary);
  });

  it.each(['rag-sources', 'groups', 'discord-channels', 'telegram-chats', 'matrix-rooms'])(
    'fails closed when exportable %s JSON is truncated',
    (name) => {
      const root = tempRoot();
      const canary = `malformed_${name}_secret_91cc`;
      mkdirSync(join(root, 'config'), { recursive: true });
      writeFileSync(join(root, 'config', `${name}.json`), `{"secret":"${canary}"`);

      const exported = buildExportBundle(root).files[`config/${name}.json`];
      expect(exported).toContain('__redacted_unparseable__');
      expect(exported).not.toContain(canary);
    },
  );

  it('masks owner JIDs and restores reordered RAG secrets by source id', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'groups.json'), JSON.stringify({
      groups: {}, mentionPatterns: [], admins: { owner: { name: 'Owner', jid: 'owner-secret@s.whatsapp.net' }, moderators: [] },
    }));
    expect(JSON.stringify(buildExportBundle(root))).not.toContain('owner-secret@s.whatsapp.net');

    const existing = { sources: [
      { id: 'one', apiKey: 'secret-one' },
      { id: 'two', apiKey: 'secret-two' },
    ] };
    const candidate = { sources: [
      { id: 'two', apiKey: { set: true } },
      { id: 'one', apiKey: { set: true } },
    ] };
    expect(restoreJsonPlaceholders(existing, candidate)).toEqual({ sources: [
      { id: 'two', apiKey: 'secret-two' },
      { id: 'one', apiKey: 'secret-one' },
    ] });
    expect(() => restoreJsonPlaceholders(existing, { sources: [{ id: 'renamed', apiKey: { set: true } }] }))
      .toThrow(/identity/i);
  });

  it('omits the read-only bridge map and binds import confirmation to target content', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'bridge-map.json'), '{"routes":[]}\n');
    writeFileSync(join(root, '.env'), 'MESSAGING_PLATFORM=discord\n');
    expect(buildExportBundle(root).files['config/bridge-map.json']).toBeUndefined();

    const bundle = { format: 'garbanzo-config-bundle-v1' as const, files: { '.env': 'MESSAGING_PLATFORM=discord\nLOG_LEVEL=debug\n' } };
    const preconditions = captureBundlePreconditions(root, bundle);
    expect(bundlePreconditionsMatch(root, preconditions)).toBe(true);
    writeFileSync(join(root, '.env'), 'MESSAGING_PLATFORM=discord\nLOG_LEVEL=warn\n');
    expect(bundlePreconditionsMatch(root, preconditions)).toBe(false);
  });

  it('preserves platform env files and writes a progress recovery manifest before updates', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.env'), 'MESSAGING_PLATFORM=discord\n');
    writeFileSync(join(root, '.env.telegram'), 'TELEGRAM_OWNER_ID=12345\n');
    writeEnvUpdate(root, { TELEGRAM_BOT_TOKEN: 'test_telegram_token' }, readEnvSnapshot(root));
    expect(readFileSync(join(root, '.env.telegram'), 'utf8')).toContain('TELEGRAM_BOT_TOKEN=test_telegram_token');
    expect(readFileSync(join(root, '.env'), 'utf8')).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(JSON.parse(readFileSync(join(root, 'data', 'config-recovery.json'), 'utf8'))).toMatchObject({
      targets: ['.env.telegram'], completed: ['.env.telegram'],
    });
  });

  it('exports a managed custom binding path under its logical config family', () => {
    const root = tempRoot();
    const custom = join(root, 'operator', 'discord.json');
    mkdirSync(join(root, 'operator'), { recursive: true });
    writeFileSync(custom, JSON.stringify({ channels: {} }));
    const exported = buildExportBundle(root, { 'config/discord-channels.json': custom });
    expect(exported.files['config/discord-channels.json']).toContain('"channels"');
  });

  it('enforces unsafe-path, expanded-size, file-count, depth, and ratio limits', () => {
    expect(validateBundleLimits({ format: 'garbanzo-config-bundle-v1', files: { '../escape': 'x' } }, 100)).toBe('unsafe-path');
    expect(validateBundleLimits({ format: 'garbanzo-config-bundle-v1', files: { 'a/b/c/d/e/f': 'x' } }, 100)).toBe('unsafe-path');
    expect(validateBundleLimits({
      format: 'garbanzo-config-bundle-v1',
      files: Object.fromEntries(Array.from({ length: IMPORT_LIMITS.files + 1 }, (_, index) => [`f${index}`, 'x'])),
    }, 1_000)).toBe('file-count-limit');
    expect(validateBundleLimits({
      format: 'garbanzo-config-bundle-v1', files: { '.env': 'x'.repeat(101) },
    }, 1)).toBe('expansion-ratio-limit');
    expect(validateBundleLimits({ format: 'garbanzo-config-bundle-v1', files: {} }, IMPORT_LIMITS.compressedBytes + 1)).toBe('compressed-size-limit');
  });

  it('keeps service wizard output byte-identical to the shared CLI runner', { timeout: 30_000 }, async () => {
    const cliRoot = tempRoot();
    const serviceRoot = tempRoot();
    const args = [
      '--platform=whatsapp', '--deploy=native', '--providers=openrouter', '--provider-order=openrouter',
      '--openrouter-key=test_key_ci', '--owner-jid=test_owner@s.whatsapp.net', '--write-groups=false',
    ];
    expect((await runWizard(cliRoot, { args })).code).toBe(0);
    applyStagedBundle(serviceRoot, cliRoot);

    const files = (root: string): string[] => readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
      .sort();
    expect(files(serviceRoot)).toEqual(files(cliRoot));
    for (const path of files(cliRoot)) {
      expect(readFileSync(join(serviceRoot, path))).toEqual(readFileSync(join(cliRoot, path)));
    }
  });

  it('emits and parses resolved WhatsApp security and scope fields', { timeout: 30_000 }, async () => {
    const root = tempRoot();
    const loginToken = 'test_whatsapp_login_token_1234';
    const args = [
      '--platform=whatsapp', '--deploy=native', '--providers=openrouter', '--provider-order=openrouter',
      '--openrouter-key=test_key_ci', '--owner-jid=test_owner@s.whatsapp.net', '--write-groups=false',
      '--whatsapp-chat-scope=configured', `--whatsapp-login-token=${loginToken}`,
    ];
    expect((await runWizard(root, { args })).code).toBe(0);
    const emitted = readFileSync(join(root, '.env.whatsapp'), 'utf8');
    expect(emitted).toContain('WHATSAPP_CHAT_SCOPE=configured');
    expect(emitted).toContain(`WHATSAPP_LOGIN_TOKEN=${loginToken}`);
    expect(emitted).toContain('WHATSAPP_SET_PROFILE_NAME=true');
    const parsed = parseConfig({
      ...parseDotenv(readFileSync(join(root, '.env'), 'utf8')),
      ...parseDotenv(emitted),
      MESSAGING_PLATFORM: 'whatsapp',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.WHATSAPP_CHAT_SCOPE).toBe('configured');
      expect(parsed.config.WHATSAPP_LOGIN_TOKEN).toBe(loginToken);
      expect(parsed.config.WHATSAPP_SET_PROFILE_NAME).toBe(true);
    }
  });
});
