import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
