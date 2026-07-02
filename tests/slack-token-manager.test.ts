import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stateFile(): string {
  return `/tmp/garbanzo-slack-token-${randomUUID()}.json`;
}

function slackResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installLoggerMock() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('../src/middleware/logger.js', () => ({ logger }));
}

describe('Slack token manager', () => {
  const stateFiles: string[] = [];

  afterEach(async () => {
    await Promise.all(stateFiles.map((path) => rm(path, { force: true })));
    stateFiles.length = 0;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('shares one in-flight refresh across concurrent forceRefresh calls', async () => {
    installLoggerMock();
    const pending = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => pending.promise);
    const { createSlackTokenProvider } = await import('../src/platforms/slack/token-manager.js');
    const file = stateFile();
    stateFiles.push(file);

    const provider = createSlackTokenProvider({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      stateFile: file,
      minBufferMinutes: 5,
    });

    const first = provider.forceRefresh();
    const second = provider.forceRefresh();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    pending.resolve(slackResponse({
      ok: true,
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 3600,
    }));

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(provider.getToken()).resolves.toBe('access-2');
  });

  it('clears a failed in-flight refresh so a later refresh can retry', async () => {
    installLoggerMock();
    const failed = deferred<Response>();
    const retry = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(() => retry.promise);
    const { createSlackTokenProvider } = await import('../src/platforms/slack/token-manager.js');
    const file = stateFile();
    stateFiles.push(file);

    const provider = createSlackTokenProvider({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      stateFile: file,
      minBufferMinutes: 5,
    });

    const first = provider.forceRefresh();
    const second = provider.forceRefresh();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    failed.resolve(slackResponse({ ok: false, error: 'invalid_auth' }));
    await expect(Promise.all([first, second])).rejects.toThrow('Slack token refresh failed: invalid_auth');

    const third = provider.forceRefresh();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    retry.resolve(slackResponse({
      ok: true,
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 3600,
    }));

    await expect(third).resolves.toBeUndefined();
    await expect(provider.getToken()).resolves.toBe('access-2');
  });
});
