process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import type { IncomingMessage, Server, ServerResponse } from 'http';
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
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };

    server.once('listening', onListening);
    server.once('error', onError);
  });

  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Expected health server to listen on a TCP port');
  }

  return address.port;
}

async function startEphemeralHealthServer(
  options: Parameters<(typeof import('../src/middleware/health.js'))['startHealthServer']>[2],
): Promise<string> {
  const { startHealthServer } = await loadHealthModule();
  const server = startHealthServer(0, '127.0.0.1', options);
  const port = await waitForListening(server);
  return `http://127.0.0.1:${port}`;
}

describe('health login wiring', () => {
  afterEach(async () => {
    const { stopHealthServer } = await loadHealthModule();
    stopHealthServer();
    vi.restoreAllMocks();
  });

  it('requires the auth token for metrics when metrics are enabled', async () => {
    const baseUrl = await startEphemeralHealthServer({ metricsEnabled: true, authToken: 'T' });

    const unauthorized = await fetch(`${baseUrl}/metrics`);
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: 'unauthorized' });

    const authorized = await fetch(`${baseUrl}/metrics?token=T`);
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('content-type')).toContain('text/plain');
    await expect(authorized.text()).resolves.toContain('garbanzo_up_time_seconds');
  });

  it('lets an extra handler own matching requests before the health branch runs', async () => {
    const extraHandler = vi.fn((req: IncomingMessage, res: ServerResponse): boolean => {
      if ((req.url ?? '').startsWith('/whatsapp/login')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('login handler owned request');
        return true;
      }

      return false;
    });

    const baseUrl = await startEphemeralHealthServer({
      metricsEnabled: true,
      authToken: 'T',
      extraHandler,
    });

    const response = await fetch(`${baseUrl}/whatsapp/login?token=T`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('login handler owned request');
    expect(extraHandler).toHaveBeenCalledTimes(1);
  });

  it('never authorizes metrics against an empty expected token', async () => {
    const baseUrl = await startEphemeralHealthServer({ metricsEnabled: true, authToken: '' });

    const emptyProvided = await fetch(`${baseUrl}/metrics?token=`);
    expect(emptyProvided.status).toBe(401);

    const noToken = await fetch(`${baseUrl}/metrics`);
    expect(noToken.status).toBe(401);
  });

  it('leaves health ungated when an auth token is configured', async () => {
    const baseUrl = await startEphemeralHealthServer({ metricsEnabled: true, authToken: 'T' });

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: expect.any(String) });
  });
});
