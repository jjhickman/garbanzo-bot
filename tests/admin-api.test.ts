process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.VECTOR_STORE = 'none';

import { request } from 'http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addMemory,
  deleteMemory,
  getAdminAuditLog,
  getAllMemories,
} from '../src/utils/db.js';
import {
  startAdminApiListener,
  type AdminApiListener,
} from '../src/middleware/admin-api/index.js';

const TOKEN = 'admin_test_token_1234';

interface ResponseResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function callApi(
  port: number,
  path: string,
  options: { method?: string; token?: string; host?: string; nonce?: string } = {},
): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: options.host ?? `127.0.0.1:${port}`,
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.nonce) headers['X-Confirm-Nonce'] = options.nonce;

    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: raw ? JSON.parse(raw) as unknown : undefined,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('in-bot admin memory API', () => {
  let listener: AdminApiListener | null = null;
  const memoryIds: number[] = [];

  beforeEach(() => {
    listener = null;
  });

  afterEach(async () => {
    await listener?.stop();
    for (const id of memoryIds.splice(0)) await deleteMemory(id);
  });

  async function start(options: { now?: () => number; nonceTtlMs?: number } = {}): Promise<AdminApiListener> {
    const started = await startAdminApiListener({
      enabled: true,
      token: TOKEN,
      port: 0,
      bindHost: '127.0.0.1',
      sharedMemoryEnabled: false,
      ...options,
    });
    expect(started).not.toBeNull();
    listener = started;
    return started as AdminApiListener;
  }

  it('does not create a listener when disabled', async () => {
    listener = await startAdminApiListener({
      enabled: false,
      token: undefined,
      port: 0,
      bindHost: '127.0.0.1',
      sharedMemoryEnabled: false,
    });

    expect(listener).toBeNull();
  });

  it('requires a header bearer, rejects query tokens, and enforces the Host allowlist', async () => {
    const server = await start();

    expect((await callApi(server.port, '/api/memory')).status).toBe(401);
    expect((await callApi(server.port, `/api/memory?token=${TOKEN}`)).status).toBe(401);
    expect((await callApi(server.port, '/api/memory', { token: TOKEN, host: 'evil.example' })).status).toBe(403);

    const ok = await callApi(server.port, '/api/memory', { token: TOKEN });
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lists memory fields needed by the SPA', async () => {
    const entry = await addMemory('Admin API list fact', 'general', 'owner');
    memoryIds.push(entry.id);
    const server = await start();

    const response = await callApi(server.port, '/api/memory', { token: TOKEN });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      memories: expect.arrayContaining([
        {
          id: entry.id,
          fact: entry.fact,
          category: entry.category,
          source: entry.source,
          createdAt: entry.created_at,
        },
      ]),
    });
  });

  it('uses a five-minute single-use nonce before deleting through the shared DB path', async () => {
    const fact = `Delete preview ${'x'.repeat(220)}`;
    const entry = await addMemory(fact, 'general', 'owner');
    memoryIds.push(entry.id);
    const server = await start();

    const preview = await callApi(server.port, `/api/memory/${entry.id}`, {
      method: 'DELETE',
      token: TOKEN,
    });
    expect(preview.status).toBe(202);
    expect(preview.body).toMatchObject({
      nonce: expect.any(String),
      expiresAt: expect.any(Number),
      preview: { id: entry.id },
    });
    const previewBody = preview.body as { nonce: string; preview: { fact: string } };
    expect(previewBody.preview.fact.length).toBeLessThan(fact.length);

    const deleted = await callApi(server.port, `/api/memory/${entry.id}`, {
      method: 'DELETE',
      token: TOKEN,
      nonce: previewBody.nonce,
    });
    expect(deleted.status).toBe(200);
    expect((await getAllMemories()).some((memory) => memory.id === entry.id)).toBe(false);
    memoryIds.splice(memoryIds.indexOf(entry.id), 1);

    const replay = await callApi(server.port, `/api/memory/${entry.id}`, {
      method: 'DELETE',
      token: TOKEN,
      nonce: previewBody.nonce,
    });
    expect([409, 410]).toContain(replay.status);

    const audits = await getAdminAuditLog(20);
    const audit = audits.find((row) => row.action === 'memory.delete' && row.target === String(entry.id));
    expect(audit).toMatchObject({ sourceIp: expect.any(String) });
    expect(audit?.summary).toContain(`Memory #${entry.id}`);
    expect(audit?.summary).not.toContain(TOKEN);
    expect((audit?.summary.length ?? 0)).toBeLessThanOrEqual(240);
  });

  it('rejects an expired nonce', async () => {
    let now = 1_000_000;
    const entry = await addMemory('Expiring nonce fact', 'general', 'owner');
    memoryIds.push(entry.id);
    const server = await start({ now: () => now, nonceTtlMs: 300_000 });
    const preview = await callApi(server.port, `/api/memory/${entry.id}`, {
      method: 'DELETE',
      token: TOKEN,
    });
    const nonce = (preview.body as { nonce: string }).nonce;

    now += 300_001;
    const expired = await callApi(server.port, `/api/memory/${entry.id}`, {
      method: 'DELETE',
      token: TOKEN,
      nonce,
    });

    expect(expired.status).toBe(410);
    expect((await getAllMemories()).some((memory) => memory.id === entry.id)).toBe(true);
  });

  it('rejects share and unshare when shared memory is disabled', async () => {
    const entry = await addMemory('Private local fact', 'general', 'owner');
    memoryIds.push(entry.id);
    const server = await start();

    expect((await callApi(server.port, `/api/memory/${entry.id}/share`, {
      method: 'POST', token: TOKEN,
    })).status).toBe(409);
    expect((await callApi(server.port, `/api/memory/${entry.id}/unshare`, {
      method: 'POST', token: TOKEN,
    })).status).toBe(409);
  });

  it('closes cleanly and stops accepting connections', async () => {
    const server = await start();
    const port = server.port;

    await server.stop();
    listener = null;

    await expect(callApi(port, '/api/memory', { token: TOKEN })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });
});
