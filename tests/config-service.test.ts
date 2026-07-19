import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startConfigService, WIZARD_ARG_ALLOWLIST, type ConfigServiceHandle } from '../src/cli/config-service/index.js';
import { MESSAGING_PLATFORMS } from '../src/config-core/fields.js';
import { runWizard } from '../src/cli/config-service/wizard.js';
import { parseCliCommand } from '../src/cli.js';

function call(port: number, token: string | null, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: string }> {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: {
      Host: `localhost:${port}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {}),
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

describe('host config service mutations', () => {
  const roots: string[] = [];
  const services: ConfigServiceHandle[] = [];
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  async function setup(): Promise<{ root: string; handle: ConfigServiceHandle; token: string }> {
    const root = mkdtempSync(join(tmpdir(), 'garbanzo-config-mutation-'));
    roots.push(root);
    const handle = await startConfigService({ root, port: 0, idleTtlMs: 60_000, print: () => undefined });
    services.push(handle);
    const exchanged = await call(handle.port, handle.entryToken, '/api/session', 'POST');
    return { root, handle, token: (JSON.parse(exchanged.body) as { token: string }).token };
  }

  it('parses the config CLI subcommand and forwards its arguments', () => {
    expect(parseCliCommand(['config', '--port=8737', '--root=/tmp/example'])).toEqual({
      kind: 'config',
      args: ['--port=8737', '--root=/tmp/example'],
    });
  });

  it('reports the effective platform and instance identity in state', async () => {
    const { root, handle, token } = await setup();
    writeFileSync(join(root, '.env'), 'MESSAGING_PLATFORM=discord\nINSTANCE_ID=community-discord\n');

    const state = await call(handle.port, token, '/api/state');

    expect(state.status).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({
      platform: 'discord',
      instanceId: 'community-discord',
      platforms: ['discord'],
      envFiles: { '.env': true },
    });
  });

  it('serves a stable, bearer-gated wizard schema without secret defaults', async () => {
    const { handle, token } = await setup();

    const unauthorized = await call(handle.port, null, '/api/wizard/schema');
    expect(unauthorized.status).toBe(401);

    const first = await call(handle.port, token, '/api/wizard/schema');
    const second = await call(handle.port, token, '/api/wizard/schema');
    expect(first.status).toBe(200);
    expect(second.body).toBe(first.body);

    const schema = JSON.parse(first.body) as {
      platforms: string[];
      providers: string[];
      groups: Record<string, Array<{ env: string; default: string; secret: boolean }>>;
    };
    // Only wizard-configurable platforms are offered: slack (demo-only, no field
    // group) is excluded even though it is a valid MESSAGING_PLATFORM.
    expect(schema.platforms).toEqual(MESSAGING_PLATFORMS.filter((p) => p !== 'slack'));
    expect(schema.platforms).not.toContain('slack');
    // The provider order picker must never offer a provider parseConfig rejects:
    // ollama is a local fallback, not a member of AI_PROVIDER_ORDER.
    expect(schema.providers).not.toContain('ollama');
    expect(schema.providers).toEqual(['openrouter', 'anthropic', 'openai', 'gemini', 'bedrock']);
    expect(schema.groups).toHaveProperty('shared');
    expect(schema.groups).toHaveProperty('discord');
    expect(schema.groups.discord.some((field) => field.env === 'DISCORD_BOT_TOKEN')).toBe(true);
    expect(Object.values(schema.groups).flat().filter((field) => field.secret)
      .every((field) => field.default === '')).toBe(true);
  });

  it('preserves unknown env keys and rejects stale mtimes', async () => {
    const { root, handle, token } = await setup();
    const envPath = join(root, '.env');
    writeFileSync(envPath, 'MESSAGING_PLATFORM=discord\nAI_PROVIDER_ORDER=openai\nOPENAI_API_KEY=test_key_old\nOPERATOR_CUSTOM=value\n');
    const read = await call(handle.port, token, '/api/config');
    const config = JSON.parse(read.body) as { mtimeMs: number; fileMtimes: Record<string, number | null>; fileHashes: Record<string, string | null> };
    const update = await call(handle.port, token, '/api/config', 'PUT', {
      mtimeMs: config.mtimeMs,
      fileMtimes: config.fileMtimes,
      fileHashes: config.fileHashes,
      update: { OPENAI_API_KEY: 'test_key_new', LOG_LEVEL: 'debug' },
    });
    expect(update.status).toBe(200);
    expect(readFileSync(envPath, 'utf8')).toContain('OPERATOR_CUSTOM=value');

    const stale = await call(handle.port, token, '/api/config', 'PUT', {
      mtimeMs: config.mtimeMs,
      update: { LOG_LEVEL: 'info' },
    });
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body)).toMatchObject({ reason: 'changed-on-disk' });
    expect(statSync(envPath).isFile()).toBe(true);
  });

  it('writes a secret-safe audit line and rejects unsafe import bundle paths', async () => {
    const { root, handle, token } = await setup();
    writeFileSync(join(root, '.env'), 'MESSAGING_PLATFORM=discord\nAI_PROVIDER_ORDER=openai\nOPENAI_API_KEY=test_key_old\n');
    const current = JSON.parse((await call(handle.port, token, '/api/config')).body) as { mtimeMs: number; fileMtimes: Record<string, number | null>; fileHashes: Record<string, string | null> };
    const canary = 'audit_secret_canary_91aa';
    expect((await call(handle.port, token, '/api/config', 'PUT', {
      mtimeMs: current.mtimeMs,
      fileMtimes: current.fileMtimes,
      fileHashes: current.fileHashes,
      update: { OPENAI_API_KEY: canary },
    })).status).toBe(200);
    const audit = readFileSync(join(root, 'data', 'config-audit.jsonl'), 'utf8');
    expect(audit).not.toContain(canary);
    expect(audit).toContain('OPENAI_API_KEY');

    const traversal = await call(handle.port, token, '/api/import', 'POST', {
      files: { '../escape': 'bad' },
    });
    expect(traversal.status).toBe(422);
    expect(existsSync(join(root, '..', 'escape'))).toBe(false);
  });

  it('produces wizard files byte-identical to the CLI runner', { timeout: 30_000 }, async () => {
    const { root, handle, token } = await setup();
    const twin = mkdtempSync(join(tmpdir(), 'garbanzo-config-wizard-twin-'));
    roots.push(twin);
    const fields = {
      MESSAGING_PLATFORM: 'whatsapp',
      DEPLOY_TARGET: 'native',
      AI_PROVIDER_ORDER: 'openrouter',
      OPENROUTER_API_KEY: 'test_key_ci',
      OWNER_JID: 'test_owner@s.whatsapp.net',
      VECTOR_STORE: 'none',
    };
    const args = ['--group-id=test_group@g.us', '--group-name=Events'];
    expect(args.every((arg) => WIZARD_ARG_ALLOWLIST.has(arg.slice(0, arg.indexOf('='))))).toBe(true);
    const response = await call(handle.port, token, '/api/wizard', 'POST', { fields, args });
    expect(response.status).toBe(200);
    expect((await runWizard(twin, { fields, args })).code).toBe(0);

    const files = (directory: string): string[] => readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
      .filter((path) => !path.startsWith('data/'))
      .sort();
    expect(files(root)).toEqual(files(twin));
    for (const path of files(twin)) {
      expect(readFileSync(join(root, path))).toEqual(readFileSync(join(twin, path)));
    }
  });

  it('leaves public scalar arrays unmasked and restores only real secret placeholders on PUT', async () => {
    const { root, handle, token } = await setup();
    const dir = join(root, 'config');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'groups.json'), `${JSON.stringify({
      groups: {},
      mentionPatterns: ['@garbanzo', 'hey bean'],
      admins: { owner: { name: 'Owner', jid: 'test_owner@s.whatsapp.net' }, moderators: [] },
      tokens: ['test_secret_token'],
    }, null, 2)}\n`);
    const original = {
      bandRoleIds: ['role-a', 'role-b'],
      channels: { '111': { name: 'general', enabled: true, requireMention: true } },
    };
    writeFileSync(join(dir, 'discord-channels.json'), `${JSON.stringify(original, null, 2)}\n`);

    const cfg = JSON.parse((await call(handle.port, token, '/api/config')).body) as {
      files: Record<string, { value: unknown; mtimeMs: number; sha256: string } | null>;
    };
    const file = cfg.files['discord-channels'];
    const groups = cfg.files.groups?.value as {
      mentionPatterns: string[];
      admins: { owner: { jid: unknown } };
      tokens: unknown[];
    };
    expect(file).toBeTruthy();
    expect((file?.value as { bandRoleIds: string[] }).bandRoleIds).toEqual(['role-a', 'role-b']);
    expect(groups.mentionPatterns).toEqual(['@garbanzo', 'hey bean']);
    expect(groups.admins.owner.jid).toEqual({ set: true });
    expect(groups.tokens).toEqual([{ set: true }]);

    const put = await call(handle.port, token, '/api/config-file/discord-channels', 'PUT', {
      mtimeMs: file?.mtimeMs, sha256: file?.sha256, value: file?.value,
    });
    expect(put.status).toBe(200);

    const onDisk = JSON.parse(readFileSync(join(dir, 'discord-channels.json'), 'utf8')) as { bandRoleIds: string[] };
    expect(onDisk.bandRoleIds).toEqual(['role-a', 'role-b']); // real values restored, not {set:true}
  });

  it('rejects config-file writes when the sha256 precondition is stale', async () => {
    const { root, handle, token } = await setup();
    const dir = join(root, 'config');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'discord-channels.json');
    const content = Buffer.from('{"channels":{}}\n');
    writeFileSync(path, content);

    const loaded = await call(handle.port, token, '/api/config-file/discord-channels');
    expect(loaded.status).toBe(200);
    const snapshot = JSON.parse(loaded.body) as { value: unknown; mtimeMs: number; sha256: string };
    expect(snapshot.sha256).toBe(createHash('sha256').update(content).digest('hex'));

    const stale = await call(handle.port, token, '/api/config-file/discord-channels', 'PUT', {
      mtimeMs: snapshot.mtimeMs,
      sha256: '0'.repeat(64),
      value: snapshot.value,
    });
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body)).toEqual({ reason: 'changed-on-disk' });
  });

  it('uses sha256 to catch changed content with a forged matching mtime', async () => {
    const { root, handle, token } = await setup();
    const dir = join(root, 'config');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'discord-channels.json');
    writeFileSync(path, '{"channels":{"111":{"name":"one","enabled":true,"requireMention":true}}}\n');
    const originalStat = statSync(path);
    utimesSync(path, originalStat.atime, new Date(1_700_000_000_000));
    const loaded = JSON.parse((await call(handle.port, token, '/api/config-file/discord-channels')).body) as {
      value: unknown; mtimeMs: number; sha256: string;
    };

    writeFileSync(path, '{"channels":{"222":{"name":"two","enabled":true,"requireMention":true}}}\n');
    const changedStat = statSync(path);
    utimesSync(path, changedStat.atime, new Date(loaded.mtimeMs));
    expect(statSync(path).mtimeMs).toBe(loaded.mtimeMs);

    const stale = await call(handle.port, token, '/api/config-file/discord-channels', 'PUT', {
      mtimeMs: loaded.mtimeMs,
      sha256: loaded.sha256,
      value: loaded.value,
    });
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body)).toEqual({ reason: 'changed-on-disk' });
  });

  it('rejects non-allowlisted wizard args before running setup', async () => {
    const { handle, token } = await setup();
    const response = await call(handle.port, token, '/api/wizard', 'POST', {
      args: ['--dry-run'],
    });

    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toEqual({ error: 'wizard arg not allowed: --dry-run' });

    const injected = await call(handle.port, token, '/api/wizard', 'POST', {
      args: ['--group-id=--dry-run'],
    });
    expect(injected.status).toBe(422);
    expect(JSON.parse(injected.body)).toEqual({
      error: 'wizard arg value must not start with "-": --group-id',
    });
  });

  it('surfaces the setup runner failure reason without leaking secrets', { timeout: 30_000 }, async () => {
    const { handle, token } = await setup();
    const response = await call(handle.port, token, '/api/wizard', 'POST', {
      fields: {
        MESSAGING_PLATFORM: 'discord',
        DEPLOY_TARGET: 'native',
        AI_PROVIDER_ORDER: 'openai',
        OPENAI_API_KEY: 'sk-secret-canary-must-not-leak',
        DISCORD_BOT_TOKEN: 'tok',
        DISCORD_OWNER_ID: '123456789012345678',
        persona: 'this-persona-does-not-exist',
      },
      args: ['--discord-channel-ids=987654321098765432'],
    });
    expect(response.status).toBe(422);
    const body = JSON.parse(response.body) as { issues: unknown[]; message?: string };
    expect(body.message).toContain('Unknown persona');
    // The runner's reason must never echo a submitted secret value.
    expect(response.body).not.toContain('sk-secret-canary-must-not-leak');
  });

  it('rejects an import body over the compressed limit', { timeout: 30_000 }, async () => {
    const { handle, token } = await setup();
    const response = await call(handle.port, token, '/api/import', 'POST', {
      files: { '.env': 'x'.repeat(10 * 1024 * 1024 + 1) },
    });
    expect(response.status).toBe(413);
  });
});
