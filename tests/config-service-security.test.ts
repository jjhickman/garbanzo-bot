import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startConfigService, type ConfigServiceHandle } from '../src/cli/config-service/index.js';

type HttpResult = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function call(port: number, path: string, options: { method?: string; host?: string; token?: string; body?: unknown } = {}): Promise<HttpResult> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: {
        Host: options.host ?? `127.0.0.1:${port}`,
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

describe('host config service security', () => {
  const roots: string[] = [];
  const services: ConfigServiceHandle[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function service(webDist?: string): Promise<{ root: string; handle: ConfigServiceHandle; token: string }> {
    const root = mkdtempSync(join(tmpdir(), 'garbanzo-config-service-'));
    roots.push(root);
    const handle = await startConfigService({ root, port: 0, idleTtlMs: 60_000, print: () => undefined, webDist });
    services.push(handle);
    const exchange = await call(handle.port, '/api/session', { method: 'POST', token: handle.entryToken });
    expect(exchange.status).toBe(200);
    return { root, handle, token: (JSON.parse(exchange.body) as { token: string }).token };
  }

  it('requires bearer auth, rejects query tokens and applies Host/CORS policy', async () => {
    const { handle, token } = await service();

    expect((await call(handle.port, '/api/state')).status).toBe(401);
    expect((await call(handle.port, `/api/state?token=${encodeURIComponent(token)}`)).status).toBe(401);
    expect((await call(handle.port, '/', { host: 'evil.example' })).status).toBe(403);
    expect((await call(handle.port, '/api/state', { host: 'evil.example', token })).status).toBe(403);

    const shell = await call(handle.port, '/');
    expect(shell.status).toBe(200);
    expect(shell.headers['content-security-policy']).toContain("script-src 'self'");
    expect(shell.body).not.toContain('/shell.js');
    expect(shell.body).not.toContain('<script>');
    expect(shell.headers['access-control-allow-origin']).toBeUndefined();
    const state = await call(handle.port, '/api/state', { token });
    expect(state.status).toBe(200);
    expect(state.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves a clear CSP-safe fallback when built web assets are unavailable', async () => {
    const missingWebDist = join(tmpdir(), `garbanzo-missing-web-${Date.now()}`);
    const { handle } = await service(missingWebDist);
    const shell = await call(handle.port, '/');

    expect(shell.status).toBe(200);
    expect(shell.body).toContain('npm run build:web');
    expect(shell.body).not.toContain('<script');
    expect(shell.body).not.toContain('style=');
  });

  it('serves built SPA assets without bearer authentication', async () => {
    const webDist = mkdtempSync(join(tmpdir(), 'garbanzo-built-web-'));
    roots.push(webDist);
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><script type="module" src="/assets/index-test123.js"></script>');
    const assets = join(webDist, 'assets');
    mkdirSync(assets);
    writeFileSync(join(assets, 'index-test123.js'), 'document.body.dataset.ready="true";');
    const { handle } = await service(webDist);

    const shell = await call(handle.port, '/');
    const script = await call(handle.port, '/assets/index-test123.js');

    expect(shell.status).toBe(200);
    expect(shell.body).toContain('/assets/index-test123.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toContain('text/javascript');
  });

  it('serves favicon requests without bearer authentication', async () => {
    const { handle } = await service();

    for (const path of ['/favicon.svg', '/favicon.ico']) {
      const favicon = await call(handle.port, path);
      expect(favicon.status).toBe(200);
      expect(favicon.headers['content-type']).toContain('image/svg+xml');
      expect(favicon.body).toContain('<svg');
    }
  });

  it('refuses assets reached through a symlink escaping web/dist', async () => {
    const webDist = mkdtempSync(join(tmpdir(), 'garbanzo-symlink-web-'));
    roots.push(webDist);
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><script type="module" src="/assets/app.js"></script>');
    const assets = join(webDist, 'assets');
    mkdirSync(assets);
    const secretDir = mkdtempSync(join(tmpdir(), 'garbanzo-symlink-secret-'));
    roots.push(secretDir);
    writeFileSync(join(secretDir, 'secret.txt'), 'TOP_SECRET_symlink_abcd');
    // A poisoned build could plant a symlink inside assets/ pointing outside the
    // web root; the unauthenticated asset route must not follow it.
    symlinkSync(join(secretDir, 'secret.txt'), join(assets, 'leak.js'));
    const { handle } = await service(webDist);

    const leak = await call(handle.port, '/assets/leak.js');
    expect(leak.status).toBe(404);
    expect(leak.body).not.toContain('TOP_SECRET_symlink_abcd');
  });

  it('falls back instead of serving a symlinked index.html', async () => {
    const webDist = mkdtempSync(join(tmpdir(), 'garbanzo-symlink-index-'));
    roots.push(webDist);
    const secretDir = mkdtempSync(join(tmpdir(), 'garbanzo-symlink-index-secret-'));
    roots.push(secretDir);
    writeFileSync(join(secretDir, 'secret.html'), '<!doctype html>SECRET_INDEX_wxyz');
    symlinkSync(join(secretDir, 'secret.html'), join(webDist, 'index.html'));
    const { handle } = await service(webDist);

    const shell = await call(handle.port, '/');
    expect(shell.status).toBe(200);
    expect(shell.body).not.toContain('SECRET_INDEX_wxyz');
    expect(shell.body).toContain('npm run build:web');
  });

  it('does not extend the idle auto-exit window on unauthenticated requests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'garbanzo-idle-unauth-'));
    roots.push(root);
    const handle = await startConfigService({ root, port: 0, idleTtlMs: 300, print: () => undefined });
    services.push(handle);
    let closed = false;
    void handle.closed.then(() => { closed = true; });
    // Hammer the unauthenticated shell for well over one idle window; auto-exit
    // must still fire because no authenticated activity occurred.
    const started = Date.now();
    while (Date.now() - started < 1500 && !closed) {
      try {
        await call(handle.port, '/');
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(closed).toBe(true);
  });

  it('keeps the service alive across continuous authenticated activity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'garbanzo-idle-auth-'));
    roots.push(root);
    const handle = await startConfigService({ root, port: 0, idleTtlMs: 300, print: () => undefined });
    services.push(handle);
    const exchange = await call(handle.port, '/api/session', { method: 'POST', token: handle.entryToken });
    expect(exchange.status).toBe(200);
    const token = (JSON.parse(exchange.body) as { token: string }).token;
    let closed = false;
    void handle.closed.then(() => { closed = true; });
    // Authenticated calls at a sub-idle cadence, spanning several idle windows.
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 120));
      expect((await call(handle.port, '/api/state', { token })).status).toBe(200);
    }
    expect(closed).toBe(false);
  });

  it('never returns a seeded secret canary', async () => {
    const { root, handle, token } = await service();
    const canary = 'canary_openai_secret_7dd4';
    writeFileSync(join(root, '.env'), `MESSAGING_PLATFORM=discord\nOPENAI_API_KEY=${canary}\nAI_PROVIDER_ORDER=openai\n`);

    for (const path of ['/api/config', '/api/export']) {
      const response = await call(handle.port, path, { token });
      expect(response.status).toBe(200);
      expect(response.body).not.toContain(canary);
    }
  });
});
