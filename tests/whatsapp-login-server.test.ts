process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { WASocket } from '@whiskeysockets/baileys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoginRequestHandler } from '../src/platforms/whatsapp/login-server.js';
import {
  __resetLoginStore,
  markLinked,
  publishQr,
  setActiveSocket,
} from '../src/platforms/whatsapp/login-store.js';

const TOKEN = 'test-login-token';

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

interface LoginStreamEvent {
  state: 'pending' | 'linked';
  qrDataUrl: string | null;
}

function startLoginServer(token = TOKEN): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const handler = createLoginRequestHandler({ token });
    const server = createServer((req, res) => {
      if (!handler(req, res)) {
        res.statusCode = 404;
        res.end('not found');
      }
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Expected TCP address'));
        return;
      }

      resolve({
        baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'unauthorized' });
}

async function openLoginStream(url: string): Promise<{
  response: Response;
  nextEvent: () => Promise<LoginStreamEvent>;
  cancel: () => Promise<void>;
}> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Expected stream body');
  const streamReader = reader;

  const decoder = new TextDecoder();
  let buffer = '';

  async function nextEvent(): Promise<LoginStreamEvent> {
    for (;;) {
      const separator = buffer.indexOf('\n\n');
      if (separator >= 0) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;
        return JSON.parse(dataLine.slice(6)) as LoginStreamEvent;
      }

      const { done, value } = await streamReader.read();
      if (done) throw new Error('SSE stream ended before next event');
      buffer += decoder.decode(value, { stream: true });
    }
  }

  return {
    response,
    nextEvent,
    cancel: async () => {
      await streamReader.cancel();
    },
  };
}

describe('WhatsApp browser login server', () => {
  let activeServer: TestServer | null = null;

  beforeEach(() => {
    __resetLoginStore();
  });

  afterEach(async () => {
    __resetLoginStore();
    vi.restoreAllMocks();

    if (activeServer) {
      await activeServer.close();
      activeServer = null;
    }
  });

  async function server(): Promise<TestServer> {
    activeServer = await startLoginServer();
    return activeServer;
  }

  it('returns 401 when the page token is missing or wrong', async () => {
    const { baseUrl } = await server();

    await expectUnauthorized(await fetch(`${baseUrl}/whatsapp/login`));
    await expectUnauthorized(await fetch(`${baseUrl}/whatsapp/login?token=wrong`));
  });

  it('returns 401 when the stream token is missing or wrong', async () => {
    const { baseUrl } = await server();

    await expectUnauthorized(await fetch(`${baseUrl}/whatsapp/login/stream`));
    await expectUnauthorized(await fetch(`${baseUrl}/whatsapp/login/stream?token=wrong`));
  });

  it('returns 401 when the pair token is missing or wrong', async () => {
    const { baseUrl } = await server();
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '15551234567' }),
    };

    await expectUnauthorized(await fetch(`${baseUrl}/whatsapp/login/pair`, init));
    await expectUnauthorized(await fetch(`${baseUrl}/whatsapp/login/pair?token=wrong`, init));
  });

  it('serves a two-tab login page for a valid token', async () => {
    const { baseUrl } = await server();

    const response = await fetch(`${baseUrl}/whatsapp/login?token=${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body).toContain('Scan QR');
    expect(body).toContain('Pair with code');
  });

  it('streams the current snapshot and login store updates', async () => {
    const { baseUrl } = await server();
    const stream = await openLoginStream(`${baseUrl}/whatsapp/login/stream?token=${TOKEN}`);

    await expect(stream.nextEvent()).resolves.toEqual({ state: 'pending', qrDataUrl: null });

    publishQr('x');
    const qrEvent = await stream.nextEvent();
    expect(qrEvent.state).toBe('pending');
    expect(qrEvent.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    markLinked();
    await expect(stream.nextEvent()).resolves.toEqual({ state: 'linked', qrDataUrl: null });

    await stream.cancel();
  });

  it('rejects invalid pair phone numbers', async () => {
    const { baseUrl } = await server();

    const response = await fetch(`${baseUrl}/whatsapp/login/pair?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '12-34' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_phone' });
  });

  it('returns not_ready when pairing without an active socket', async () => {
    const { baseUrl } = await server();

    const response = await fetch(`${baseUrl}/whatsapp/login/pair?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '+1 (555) 123-4567' }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'not_ready' });
  });

  it('requests a pairing code from the active socket using normalized digits', async () => {
    const { baseUrl } = await server();
    const requestPairingCode = vi.fn<() => Promise<string>>().mockResolvedValue('ABCD1234');
    setActiveSocket({ requestPairingCode } as unknown as WASocket);

    const response = await fetch(`${baseUrl}/whatsapp/login/pair?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '+1 (555) 123-4567' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: 'ABCD1234' });
    expect(requestPairingCode).toHaveBeenCalledWith('15551234567');
  });
});
