import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startConfigService, type ConfigServiceHandle } from '../src/cli/config-service/index.js';
import { runWizard } from '../src/cli/config-service/wizard.js';
import { parseCliCommand } from '../src/cli.js';

function call(port: number, token: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: string }> {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: {
      Host: `localhost:${port}`,
      Authorization: `Bearer ${token}`,
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
    const args = [
      '--platform=whatsapp',
      '--deploy=native',
      '--providers=openrouter',
      '--provider-order=openrouter',
      '--openrouter-key=test_key_ci',
      '--owner-jid=test_owner@s.whatsapp.net',
      '--write-groups=false',
    ];
    const response = await call(handle.port, token, '/api/wizard', 'POST', { args });
    expect(response.status).toBe(200);
    expect((await runWizard(twin, { args })).code).toBe(0);

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

  it('rejects an import body over the compressed limit', { timeout: 30_000 }, async () => {
    const { handle, token } = await setup();
    const response = await call(handle.port, token, '/api/import', 'POST', {
      files: { '.env': 'x'.repeat(10 * 1024 * 1024 + 1) },
    });
    expect(response.status).toBe(413);
  });
});
