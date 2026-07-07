process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.MONITORING_TOKEN ??= 'bridge-test-token';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEnvelope } from '../src/bridge/envelope.js';
import { createHttpBridgeTransport } from '../src/bridge/transport-http.js';
import { TransportDeliveryError, type BridgeTransport } from '../src/bridge/transport.js';

type FetchCall = {
  input: string | URL | Request;
  init: RequestInit | undefined;
};

function envelope(id: string): BridgeEnvelope {
  return {
    v: 1,
    routeId: 'route-1',
    origin: {
      instance: 'whatsapp-main',
      platform: 'whatsapp',
      chatId: 'source-chat',
      messageId: id,
      senderId: 'sender-1',
    },
    targetInstance: 'discord-main',
    targetChatId: 'target-chat',
    text: `hello ${id}`,
    kind: 'message',
    sentAtMs: 1_800_000_000_000,
    idempotencyKey: `whatsapp-main:source-chat:${id}`,
  };
}

function installFetch(
  handler: (call: FetchCall) => Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args;
    const call = { input, init };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  return new Headers(headers).get(name);
}

export function runTransportContract(makeTransport: () => BridgeTransport): void {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delivers an envelope with bearer auth on 202', async () => {
    const calls = installFetch(async () => new Response('accepted', { status: 202 }));

    await expect(makeTransport().deliver(envelope('happy-1'), 'http://discord.local'))
      .resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe('http://discord.local/bridge/inbound');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(headerValue(calls[0]?.init?.headers, 'authorization')).toBe('Bearer bridge-test-token');
    expect(headerValue(calls[0]?.init?.headers, 'content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init?.body ?? '{}'))).toMatchObject({
      idempotencyKey: 'whatsapp-main:source-chat:happy-1',
    });
  });

  it('treats 401 as non-retryable', async () => {
    installFetch(async () => new Response('unauthorized', { status: 401 }));

    await expect(makeTransport().deliver(envelope('unauthorized-1'), 'http://discord.local'))
      .rejects.toMatchObject({ retryable: false });
  });

  it('treats 500 as retryable', async () => {
    installFetch(async () => new Response('server error', { status: 500 }));

    await expect(makeTransport().deliver(envelope('server-1'), 'http://discord.local'))
      .rejects.toMatchObject({ retryable: true });
  });

  it('treats timeout as retryable', async () => {
    installFetch(async () => {
      throw new Error('The operation was aborted due to timeout');
    });

    await expect(makeTransport().deliver(envelope('timeout-1'), 'http://discord.local'))
      .rejects.toMatchObject({ retryable: true });
  });

  it('does not deduplicate repeated deliveries', async () => {
    const calls = installFetch(async () => new Response('accepted', { status: 202 }));
    const env = envelope('duplicate-1');
    const transport = makeTransport();

    await transport.deliver(env, 'http://discord.local');
    await transport.deliver(env, 'http://discord.local');

    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]?.init?.body ?? '{}')).idempotencyKey)
      .toBe(JSON.parse(String(calls[1]?.init?.body ?? '{}')).idempotencyKey);
  });
}

describe('HTTP bridge transport contract', () => {
  runTransportContract(() => createHttpBridgeTransport());

  it('rejects a missing target url as non-retryable', async () => {
    await expect(createHttpBridgeTransport().deliver(envelope('missing-target'), null))
      .rejects.toBeInstanceOf(TransportDeliveryError);
    await expect(createHttpBridgeTransport().deliver(envelope('missing-target'), null))
      .rejects.toMatchObject({ retryable: false });
  });
});
