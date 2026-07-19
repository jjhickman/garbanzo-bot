// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyStream,
  clearSession,
  exchangeEntryToken,
  getConfigFile,
  getState,
  getWizardSchema,
  hasSession,
  putConfigFile,
  submitWizard,
} from './api.js';

describe('config API client authentication', () => {
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('keeps tokens in memory and sends them only in Authorization headers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'session-secret' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        root: '/tmp/config',
        shape: 'bare',
        composeFiles: [],
        packageRepo: false,
        platform: 'discord',
        instanceId: 'community-discord',
        platforms: ['discord'],
        envFiles: { '.env': true },
        configFiles: {},
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await exchangeEntryToken('one-time-secret');
    expect(hasSession()).toBe(true);
    await getState();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/session', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer one-time-secret' },
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/state', expect.objectContaining({
      headers: { Authorization: 'Bearer session-secret' },
    }));
    expect(fetchMock.mock.calls.flatMap(([url]) => String(url))).not.toContain('one-time-secret');
    expect(fetchMock.mock.calls.flatMap(([url]) => String(url))).not.toContain('session-secret');
    expect(window.localStorage).toHaveLength(0);
    expect(document.cookie).toBe('');
  });

  it('clears the session and reports expiry after a 401', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'session-secret' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'bearer-required' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await exchangeEntryToken('entry-secret');
    await expect(getState()).rejects.toMatchObject({ status: 401 });
    expect(hasSession()).toBe(false);
  });

  it('loads and submits wizard data with header-only bearer auth', async () => {
    const response = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ token: 'wizard-session-secret' }))
      .mockResolvedValueOnce(response({ platforms: ['discord'], groups: {} }))
      .mockResolvedValueOnce(response({ ok: true, written: ['.env'] }));
    vi.stubGlobal('fetch', fetchMock);

    await exchangeEntryToken('wizard-entry-secret');
    await getWizardSchema();
    await submitWizard({ MESSAGING_PLATFORM: 'discord', DISCORD_BOT_TOKEN: 'test_token' });

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/wizard/schema', expect.objectContaining({
      headers: { Authorization: 'Bearer wizard-session-secret' },
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/wizard', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wizard-session-secret' },
      body: JSON.stringify({ fields: { MESSAGING_PLATFORM: 'discord', DISCORD_BOT_TOKEN: 'test_token' } }),
    }));
    expect(fetchMock.mock.calls.flatMap(([url]) => String(url))).not.toContain('wizard-session-secret');
    expect(window.localStorage).toHaveLength(0);
    expect(document.cookie).toBe('');
  });

  it('carries config-file sha256 preconditions through read and write calls', async () => {
    const response = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ token: 'config-session-secret' }))
      .mockResolvedValueOnce(response({ value: { groups: {} }, mtimeMs: 12, sha256: 'loaded-hash' }))
      .mockResolvedValueOnce(response({ ok: true, mtimeMs: 13, sha256: 'written-hash' }));
    vi.stubGlobal('fetch', fetchMock);

    await exchangeEntryToken('config-entry-secret');
    const loaded = await getConfigFile<{ groups: Record<string, unknown> }>('groups');
    await putConfigFile('groups', {
      mtimeMs: loaded.mtimeMs,
      sha256: loaded.sha256,
      value: loaded.value,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/config-file/groups', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ mtimeMs: 12, sha256: 'loaded-hash', value: { groups: {} } }),
    }));
  });

  it('streams apply output with the bearer token only in the header', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('$ docker compose up -d discord\n'));
        controller.enqueue(encoder.encode('started\nexit 0\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'apply-session-secret' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(stream, {
        status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await exchangeEntryToken('apply-entry-secret');
    const chunks: string[] = [];
    const result = await applyStream((chunk) => chunks.push(chunk));

    expect(chunks.join('')).toContain('exit 0');
    expect(result).toMatchObject({ exitCode: 0 });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/apply', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer apply-session-secret' },
    }));
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain('apply-session-secret');
    expect(window.localStorage).toHaveLength(0);
    expect(document.cookie).toBe('');
  });
});
