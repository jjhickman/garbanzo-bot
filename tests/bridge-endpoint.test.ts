process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { Readable } from 'stream';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEnvelope } from '../src/bridge/envelope.js';

async function loadHealthModule(): Promise<typeof import('../src/middleware/health.js')> {
  return import('../src/middleware/health.js');
}

type HealthOptions = Parameters<(typeof import('../src/middleware/health.js'))['startHealthServer']>[2];

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  json(): unknown;
}

function request(
  url: string,
  method: string,
  body: string | undefined,
  headers: IncomingHttpHeaders,
): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [body]);
  return Object.assign(stream, {
    url,
    method,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  }) as IncomingMessage;
}

function response(): ServerResponse & { captured: CapturedResponse } {
  const captured: CapturedResponse = {
    status: 200,
    headers: {},
    body: '',
    json() {
      return JSON.parse(this.body);
    },
  };
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers ?? {};
      this.headersSent = true;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) captured.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      this.headersSent = true;
      return this;
    },
    captured,
  };
  return res as ServerResponse & { captured: CapturedResponse };
}

async function dispatch(
  options: Parameters<(typeof import('../src/middleware/health.js'))['startHealthServer']>[2],
  init: { url?: string; method?: string; body?: string; token?: string | null; headers?: IncomingHttpHeaders } = {},
): Promise<CapturedResponse> {
  const { __testing } = await loadHealthModule();
  const headers: IncomingHttpHeaders = {
    ...(init.token === undefined ? { authorization: 'Bearer T' } : {}),
    ...(init.token === null ? {} : init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
    'content-type': 'application/json',
    ...init.headers,
  };
  const req = request(init.url ?? '/bridge/inbound', init.method ?? 'POST', init.body, headers);
  const res = response();

  await __testing.handleRequest(req, res, options);
  return res.captured;
}

function envelope(overrides: Partial<BridgeEnvelope> = {}): BridgeEnvelope {
  return {
    v: 1,
    routeId: 'route-1',
    origin: {
      instance: 'whatsapp-community',
      platform: 'whatsapp',
      chatId: 'source-chat',
      messageId: 'message-1',
      senderId: 'sender-1',
      senderName: 'Sender One',
    },
    targetInstance: 'discord-community',
    targetChatId: 'target-chat',
    text: 'hello from whatsapp',
    kind: 'message',
    sentAtMs: 1_800_000_000_000,
    idempotencyKey: 'whatsapp-community:source-chat:message-1',
    ...overrides,
  };
}

async function postEnvelope(options: HealthOptions, body: unknown, token = 'T'): Promise<CapturedResponse> {
  return dispatch(options, {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    token,
  });
}

describe('bridge inbound endpoint', () => {
  afterEach(async () => {
    const { stopHealthServer } = await loadHealthModule();
    stopHealthServer();
    vi.restoreAllMocks();
  });

  it('is 404 when no bridge inbound handler is registered', async () => {
    const response = await postEnvelope({ authToken: 'T' }, envelope());

    expect(response.status).toBe(404);
  });

  it('requires the auth token', async () => {
    const bridgeInboundHandler = vi.fn(async () => 'accepted' as const);
    const options = { authToken: 'T', bridgeInboundHandler };

    const missing = await dispatch(options, {
      body: JSON.stringify(envelope()),
      token: null,
    });
    expect(missing.status).toBe(401);
    expect(missing.json()).toEqual({ error: 'unauthorized' });

    const wrong = await postEnvelope(options, envelope(), 'WRONG');
    expect(wrong.status).toBe(401);
    expect(wrong.json()).toEqual({ error: 'unauthorized' });
    expect(bridgeInboundHandler).not.toHaveBeenCalled();
  });

  it('rejects non-POST requests once authenticated', async () => {
    const bridgeInboundHandler = vi.fn(async () => 'accepted' as const);

    const response = await dispatch(
      { authToken: 'T', bridgeInboundHandler },
      { method: 'GET', url: '/bridge/inbound?token=T', token: null },
    );

    expect(response.status).toBe(405);
    expect(response.json()).toEqual({ error: 'method_not_allowed' });
    expect(bridgeInboundHandler).not.toHaveBeenCalled();
  });

  it('enforces the shared authed-route rate limit', async () => {
    const bridgeInboundHandler = vi.fn(async () => 'accepted' as const);
    const options = { authToken: 'T', bridgeInboundHandler };

    let lastStatus = 0;
    for (let i = 0; i < 125; i++) {
      const response = await postEnvelope(options, envelope({ idempotencyKey: `key-${i}` }));
      lastStatus = response.status;
    }

    expect(lastStatus).toBe(429);
  });

  it('rejects request bodies over 64KB', async () => {
    const bridgeInboundHandler = vi.fn(async () => 'accepted' as const);

    const response = await postEnvelope({ authToken: 'T', bridgeInboundHandler }, 'x'.repeat(64 * 1024 + 1));

    expect(response.status).toBe(413);
    expect(response.json()).toEqual({ error: 'payload_too_large' });
    expect(bridgeInboundHandler).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    const bridgeInboundHandler = vi.fn(async () => 'accepted' as const);

    const response = await postEnvelope({ authToken: 'T', bridgeInboundHandler }, '{not json');

    expect(response.status).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid json' });
    expect(bridgeInboundHandler).not.toHaveBeenCalled();
  });

  it('rejects invalid bridge envelopes', async () => {
    const bridgeInboundHandler = vi.fn(async () => 'accepted' as const);

    const response = await postEnvelope(
      { authToken: 'T', bridgeInboundHandler },
      { ...envelope(), extra: 'strict schema rejects this' },
    );

    expect(response.status).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid envelope' });
    expect(bridgeInboundHandler).not.toHaveBeenCalled();
  });

  it('returns accepted for a fresh envelope', async () => {
    const bridgeInboundHandler = vi.fn(async () => 'accepted' as const);

    const response = await postEnvelope({ authToken: 'T', bridgeInboundHandler }, envelope());

    expect(response.status).toBe(202);
    expect(response.json()).toEqual({ status: 'accepted' });
    expect(bridgeInboundHandler).toHaveBeenCalledWith(envelope());
  });

  it('returns duplicate when the handler reports an existing idempotency key', async () => {
    const seen = new Set<string>();
    const bridgeInboundHandler = vi.fn(async (message: BridgeEnvelope) => {
      if (seen.has(message.idempotencyKey)) return 'duplicate' as const;
      seen.add(message.idempotencyKey);
      return 'accepted' as const;
    });
    const options = { authToken: 'T', bridgeInboundHandler };

    const first = await postEnvelope(options, envelope());
    const second = await dispatch(options, {
      url: '/bridge/inbound?token=T',
      body: JSON.stringify(envelope()),
      token: null,
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.json()).toEqual({ status: 'duplicate' });
  });

  it('returns delivery failed when the handler throws', async () => {
    const bridgeInboundHandler = vi.fn(async () => {
      throw new Error('db unavailable');
    });

    const response = await postEnvelope({ authToken: 'T', bridgeInboundHandler }, envelope());

    expect(response.status).toBe(503);
    expect(response.json()).toEqual({ error: 'delivery failed' });
  });
});
