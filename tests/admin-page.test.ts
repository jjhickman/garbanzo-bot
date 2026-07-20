process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import type { Server } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadHealthModule(): Promise<typeof import('../src/middleware/health.js')> {
  return import('../src/middleware/health.js');
}

async function waitForListening(server: Server): Promise<number> {
  if (server.listening) {
    const address = server.address();
    if (typeof address === 'object' && address !== null) return address.port;
  }
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no port');
  return address.port;
}

async function startServer(
  options: Parameters<(typeof import('../src/middleware/health.js'))['startHealthServer']>[2],
): Promise<string> {
  const { startHealthServer } = await loadHealthModule();
  const server = startHealthServer(0, '127.0.0.1', options);
  const port = await waitForListening(server);
  return `http://127.0.0.1:${port}`;
}

describe('admin page', () => {
  afterEach(async () => {
    const { stopHealthServer } = await loadHealthModule();
    stopHealthServer();
    vi.restoreAllMocks();
  });

  it('is 404 when adminEnabled is false', async () => {
    const baseUrl = await startServer({ authToken: 'T' });
    const res = await fetch(`${baseUrl}/admin?token=T`);
    expect(res.status).toBe(404);
  });

  it('requires the auth token', async () => {
    const baseUrl = await startServer({ adminEnabled: true, authToken: 'T' });

    expect((await fetch(`${baseUrl}/admin`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/admin?token=WRONG`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/admin.json`)).status).toBe(401);
  });

  it('never serves admin without a configured token, even when enabled', async () => {
    const baseUrl = await startServer({ adminEnabled: true });
    const res = await fetch(`${baseUrl}/admin`);
    expect(res.status).toBe(404);
  });

  it('serves HTML with cost + group data for a valid token', async () => {
    const stats = await import('../src/middleware/stats.js');
    stats.recordGroupMessage('g1@g.us', 'alice@s.whatsapp.net');
    stats.recordBotResponse('g1@g.us');
    stats.recordAICost({ model: 'openai', inputTokens: 100, outputTokens: 50, estimatedCost: 0.0123, latencyMs: 400 });

    const baseUrl = await startServer({ adminEnabled: true, authToken: 'T' });
    const res = await fetch(`${baseUrl}/admin?token=T`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('Garbanzo');
    expect(html).toContain('openai');
    expect(html).toContain('$0.0123');
  });

  it('serves the JSON snapshot at /admin.json', async () => {
    const stats = await import('../src/middleware/stats.js');
    stats.recordAICost({ model: 'claude', inputTokens: 10, outputTokens: 5, estimatedCost: 0.002, latencyMs: 100 });

    const baseUrl = await startServer({ adminEnabled: true, authToken: 'T' });
    const res = await fetch(`${baseUrl}/admin.json?token=T`);
    expect(res.status).toBe(200);

    const body = await res.json() as { date: string; dailyCost: number; providers: Array<{ provider: string }> };
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.providers.some((p) => p.provider === 'claude')).toBe(true);
    expect(body.dailyCost).toBeGreaterThan(0);
  });

  it('escapes HTML in group-derived strings', async () => {
    const { buildAdminSnapshot, renderAdminHtml } = await import('../src/middleware/admin-page.js');
    const stats = await import('../src/middleware/stats.js');
    stats.recordGroupMessage('<script>alert(1)</script>@g.us', 'bob@s.whatsapp.net');

    const snapshot = await buildAdminSnapshot(testOverviewInputs());
    const html = renderAdminHtml(snapshot, {});
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders the Overview section with platform/instance/version/connection identity', async () => {
    const baseUrl = await startServer({ adminEnabled: true, authToken: 'T' });
    const res = await fetch(`${baseUrl}/admin?token=T`);
    const html = await res.text();

    expect(html).toContain('Overview');
    expect(html).toContain('Instance');
    expect(html).toContain('Version');
    expect(html).toContain('Connection');
  });

  it('renders an honest "not enabled" line for Bridges when bridging is off', async () => {
    const baseUrl = await startServer({ adminEnabled: true, authToken: 'T' });
    const res = await fetch(`${baseUrl}/admin?token=T`);
    const html = await res.text();

    expect(html).toContain('Bridges');
    expect(html).toContain('Bridging is not enabled');
  });

  it('surfaces the per-route media relay opt-in in the bridge table', async () => {
    const { buildAdminSnapshot, renderAdminHtml } = await import('../src/middleware/admin-page.js');
    const snapshot = await buildAdminSnapshot(testOverviewInputs());
    snapshot.bridges = {
      enabled: true,
      routes: [{
        id: 'community-main',
        endpointA: 'discord-main:channel-1',
        endpointB: 'whatsapp-main:group-1',
        direction: 'both',
        ingestRelayed: false,
        mediaRelay: true,
      }],
      outboxPending: 0,
      outboxOldestPendingAgeSeconds: null,
      deadLettered: 0,
      summaryBufferDepths: {},
    };

    const html = renderAdminHtml(snapshot, {});

    expect(html).toContain('Relays media');
    expect(html).toContain('<td>yes</td>');
  });

  it('renders every section safely on a fresh install with no data', async () => {
    const baseUrl = await startServer({ adminEnabled: true, authToken: 'T' });
    const res = await fetch(`${baseUrl}/admin?token=T`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('No facts stored yet');
    expect(html).toContain('No AI requests yet');
  });

  it('exposes memory, bridges, and health sections in /admin.json for machine-readable parity', async () => {
    const baseUrl = await startServer({ adminEnabled: true, authToken: 'T' });
    const res = await fetch(`${baseUrl}/admin.json?token=T`);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      overview: { platform: string; instanceId: string };
      memory: { totalCount: number; cap: number; rows: unknown[] };
      bridges: { enabled: boolean; routes: unknown[] };
      health: { metricsPath: string };
    };
    expect(body.overview.platform).toBeTruthy();
    expect(body.overview.instanceId).toBeTruthy();
    expect(body.memory.cap).toBe(100);
    expect(Array.isArray(body.memory.rows)).toBe(true);
    expect(body.bridges.enabled).toBe(false);
    expect(Array.isArray(body.bridges.routes)).toBe(true);
    expect(body.health.metricsPath).toBe('/metrics');
  });

  it('escapes a malicious stored fact in HTML but keeps it intact (unescaped) in JSON', async () => {
    const db = await import('../src/utils/db.js');
    const malicious = '<script>alert(1)</script>';
    await db.addMemory(malicious, 'general', 'owner');

    const baseUrl = await startServer({ adminEnabled: true, authToken: 'T' });

    const htmlRes = await fetch(`${baseUrl}/admin?token=T`);
    const html = await htmlRes.text();
    expect(html).not.toContain(malicious);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');

    const jsonRes = await fetch(`${baseUrl}/admin.json?token=T`);
    const body = await jsonRes.json() as { memory: { rows: Array<{ fact: string }> } };
    expect(body.memory.rows.some((row) => row.fact === malicious)).toBe(true);
  });
});

function testOverviewInputs(): Parameters<(typeof import('../src/middleware/admin-page.js'))['buildAdminSnapshot']>[0] {
  return {
    connectionStatus: 'connected',
    uptimeSeconds: 42,
    lastMessageAgoSeconds: null,
    stale: false,
    memoryWatchdog: { rssMB: 100, warnMB: 500, restartMB: 1024 },
  };
}
