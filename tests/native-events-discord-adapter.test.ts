import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDiscordNativeEventMethods, DISCORD_MANAGE_EVENTS_ERROR } from '../src/platforms/discord/native-events.js';

const TOKEN = 'test_tok';
const START_MS = Date.parse('2026-08-01T23:00:00.000Z');
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

interface RecordedRequest {
  url: string;
  method: string;
  body?: unknown;
  authorization?: string;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function installFetchMock(routes: Array<{ match: (url: string, method: string) => boolean; status: number; body: unknown }>) {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const urlText = String(url);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      url: urlText,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: headers.authorization,
    });

    const route = routes.find((r) => r.match(urlText, method));
    if (!route) return jsonResponse(404, { message: 'no route' });
    return jsonResponse(route.status, route.body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, fetchMock };
}

describe('Discord native event methods', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates an EXTERNAL scheduled event with defaulted end time and location', async () => {
    const { requests } = installFetchMock([
      { match: (url, method) => url.endsWith('/channels/chan-1') && method === 'GET', status: 200, body: { id: 'chan-1', guild_id: 'guild-9' } },
      { match: (url, method) => url.endsWith('/guilds/guild-9/scheduled-events') && method === 'POST', status: 200, body: { id: 'ev-1', guild_id: 'guild-9' } },
    ]);

    const methods = createDiscordNativeEventMethods(TOKEN);
    const ref = await methods.createNativeEvent('chan-1', { name: 'Trivia Night', startAtMs: START_MS });

    expect(ref).toBe(JSON.stringify({ guildId: 'guild-9', eventId: 'ev-1' }));

    const create = requests.find((r) => r.method === 'POST');
    expect(create?.url).toBe('https://discord.com/api/v10/guilds/guild-9/scheduled-events');
    expect(create?.authorization).toBe(`Bot ${TOKEN}`);
    expect(create?.body).toEqual({
      name: 'Trivia Night',
      privacy_level: 2,
      entity_type: 3,
      scheduled_start_time: new Date(START_MS).toISOString(),
      scheduled_end_time: new Date(START_MS + TWO_HOURS_MS).toISOString(),
      entity_metadata: { location: 'TBD' },
    });
  });

  it('passes explicit location, description, and end time through', async () => {
    const { requests } = installFetchMock([
      { match: (url, method) => url.endsWith('/channels/chan-1') && method === 'GET', status: 200, body: { id: 'chan-1', guild_id: 'guild-9' } },
      { match: (url, method) => url.includes('/scheduled-events') && method === 'POST', status: 200, body: { id: 'ev-2', guild_id: 'guild-9' } },
    ]);

    const methods = createDiscordNativeEventMethods(TOKEN);
    await methods.createNativeEvent('chan-1', {
      name: 'Show',
      description: 'Doors at 7',
      startAtMs: START_MS,
      endAtMs: START_MS + 60 * 60 * 1000,
      location: 'The Middle East',
    });

    const create = requests.find((r) => r.method === 'POST');
    expect(create?.body).toMatchObject({
      description: 'Doors at 7',
      scheduled_end_time: new Date(START_MS + 60 * 60 * 1000).toISOString(),
      entity_metadata: { location: 'The Middle East' },
    });
  });

  it('caches the guild id per channel across calls', async () => {
    const { requests } = installFetchMock([
      { match: (url, method) => url.endsWith('/channels/chan-1') && method === 'GET', status: 200, body: { id: 'chan-1', guild_id: 'guild-9' } },
      { match: (url, method) => url.includes('/scheduled-events') && method === 'POST', status: 200, body: { id: 'ev-3', guild_id: 'guild-9' } },
    ]);

    const methods = createDiscordNativeEventMethods(TOKEN);
    await methods.createNativeEvent('chan-1', { name: 'A', startAtMs: START_MS });
    await methods.createNativeEvent('chan-1', { name: 'B', startAtMs: START_MS });

    const channelLookups = requests.filter((r) => r.method === 'GET');
    expect(channelLookups).toHaveLength(1);
  });

  it('updates via PATCH on the stored guild/event ref and returns the same ref', async () => {
    const { requests } = installFetchMock([
      { match: (url, method) => url.endsWith('/guilds/guild-9/scheduled-events/ev-1') && method === 'PATCH', status: 200, body: { id: 'ev-1', guild_id: 'guild-9' } },
    ]);

    const methods = createDiscordNativeEventMethods(TOKEN);
    const ref = JSON.stringify({ guildId: 'guild-9', eventId: 'ev-1' });
    const newRef = await methods.updateNativeEvent('chan-1', ref, { name: 'Moved', startAtMs: START_MS });

    expect(newRef).toBe(ref);
    const patch = requests.find((r) => r.method === 'PATCH');
    expect(patch?.url).toBe('https://discord.com/api/v10/guilds/guild-9/scheduled-events/ev-1');
    expect(patch?.body).toMatchObject({ name: 'Moved', entity_type: 3 });
  });

  it('cancels via DELETE on the stored guild/event ref', async () => {
    const { requests } = installFetchMock([
      { match: (url, method) => url.endsWith('/guilds/guild-9/scheduled-events/ev-1') && method === 'DELETE', status: 204, body: {} },
    ]);

    const methods = createDiscordNativeEventMethods(TOKEN);
    const ref = JSON.stringify({ guildId: 'guild-9', eventId: 'ev-1' });
    await methods.cancelNativeEvent('chan-1', ref, { name: 'X', startAtMs: START_MS });

    const del = requests.find((r) => r.method === 'DELETE');
    expect(del?.url).toBe('https://discord.com/api/v10/guilds/guild-9/scheduled-events/ev-1');
  });

  it('translates a 403 into a Manage Events permission error', async () => {
    installFetchMock([
      { match: (url, method) => url.endsWith('/channels/chan-1') && method === 'GET', status: 200, body: { id: 'chan-1', guild_id: 'guild-9' } },
      { match: (url, method) => url.includes('/scheduled-events') && method === 'POST', status: 403, body: { message: 'Missing Permissions' } },
    ]);

    const methods = createDiscordNativeEventMethods(TOKEN);
    await expect(methods.createNativeEvent('chan-1', { name: 'Nope', startAtMs: START_MS }))
      .rejects.toThrow(DISCORD_MANAGE_EVENTS_ERROR);
  });

  it('rejects channels that are not in a guild', async () => {
    installFetchMock([
      { match: (url, method) => url.endsWith('/channels/dm-1') && method === 'GET', status: 200, body: { id: 'dm-1' } },
    ]);

    const methods = createDiscordNativeEventMethods(TOKEN);
    await expect(methods.createNativeEvent('dm-1', { name: 'Nope', startAtMs: START_MS }))
      .rejects.toThrow(/not in a server/);
  });

  it('fetches the interested-user count with with_user_count=true', async () => {
    const { requests } = installFetchMock([
      {
        match: (url, method) => url.includes('/guilds/guild-9/scheduled-events/ev-1?with_user_count=true') && method === 'GET',
        status: 200,
        body: { id: 'ev-1', guild_id: 'guild-9', user_count: 12 },
      },
    ]);

    const methods = createDiscordNativeEventMethods(TOKEN);
    const ref = JSON.stringify({ guildId: 'guild-9', eventId: 'ev-1' });
    await expect(methods.getNativeEventInterestCount('chan-1', ref)).resolves.toBe(12);
    expect(requests[0]?.url).toContain('with_user_count=true');
  });

  it('returns null when the scheduled event carries no user_count', async () => {
    installFetchMock([
      {
        match: (url, method) => url.includes('/scheduled-events/ev-1') && method === 'GET',
        status: 200,
        body: { id: 'ev-1', guild_id: 'guild-9' },
      },
    ]);

    const methods = createDiscordNativeEventMethods(TOKEN);
    const ref = JSON.stringify({ guildId: 'guild-9', eventId: 'ev-1' });
    await expect(methods.getNativeEventInterestCount('chan-1', ref)).resolves.toBeNull();
  });

  it('rejects an unrecognized ref before making any request', async () => {
    const { fetchMock } = installFetchMock([]);

    const methods = createDiscordNativeEventMethods(TOKEN);
    await expect(methods.updateNativeEvent('chan-1', 'not-json', { name: 'X', startAtMs: START_MS }))
      .rejects.toThrow(/Unrecognized/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
