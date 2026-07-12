// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSession, exchangeEntryToken, getState, hasSession } from './api.js';

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
});
