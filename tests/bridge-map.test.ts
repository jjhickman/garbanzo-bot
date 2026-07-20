process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BridgeMapSchema,
  allRoutesForInstance,
  expandBridgeMapEnvPlaceholders,
  findOutboundRoute,
  formatBridgeMapZodError,
  outboundRoutesForInstance,
} from '../src/bridge/bridge-map.js';

const validMap = {
  instances: [
    { id: 'remy', platform: 'discord', url: 'http://discord:3002' },
    { id: 'garbanzo', platform: 'whatsapp', url: 'http://whatsapp:3001' },
    { id: 'telegram-main', platform: 'telegram', url: 'http://telegram:3005' },
    { id: 'matrix-main', platform: 'matrix', url: 'http://matrix:3004' },
  ],
  routes: [
    {
      id: 'band-community',
      endpoints: [
        { instance: 'remy', chatId: '123' },
        { instance: 'garbanzo', chatId: '456@g.us' },
      ],
      direction: 'both',
    },
  ],
};

describe('bridge map config', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.TEST_BRIDGE_PORT;
    delete process.env.TEST_BRIDGE_DEFAULT_PORT;
    delete process.env.TEST_BRIDGE_REQUIRED_PORT;
  });

  it('parses a valid map and applies risk-posture defaults', () => {
    const parsed = BridgeMapSchema.parse(validMap);

    expect(parsed.routes[0]).toMatchObject({
      modeToWhatsApp: 'summary',
      modeToDiscord: 'verbatim',
      relayCommands: false,
      ingestRelayed: false,
      mediaRelay: false,
    });
  });

  it('parses an N-ary bridge group route', () => {
    const parsed = BridgeMapSchema.parse({
      ...validMap,
      routes: [{
        id: 'all-communities',
        endpoints: [
          { instance: 'remy', chatId: 'discord-channel' },
          { instance: 'garbanzo', chatId: 'whatsapp-group@g.us' },
          { instance: 'telegram-main', chatId: 'telegram-chat' },
          { instance: 'matrix-main', chatId: 'matrix-room' },
        ],
        direction: 'both',
      }],
    });

    expect(parsed.routes[0]?.endpoints).toHaveLength(4);
  });

  it('keeps 2-endpoint bridge routes valid for back-compat', () => {
    const parsed = BridgeMapSchema.parse(validMap);

    expect(parsed.routes[0]?.endpoints).toHaveLength(2);
  });

  it('keeps literal URLs unchanged for existing bridge maps', () => {
    const expanded = expandBridgeMapEnvPlaceholders(validMap);

    expect(BridgeMapSchema.parse(expanded).instances.map((instance) => instance.url)).toEqual([
      'http://discord:3002',
      'http://whatsapp:3001',
      'http://telegram:3005',
      'http://matrix:3004',
    ]);
  });

  it('expands bridge map ${VAR} placeholders from process.env before schema parsing', () => {
    process.env.TEST_BRIDGE_PORT = '3911';
    const expanded = expandBridgeMapEnvPlaceholders({
      ...validMap,
      instances: [{ id: 'remy', platform: 'discord', url: 'http://discord:${TEST_BRIDGE_PORT}' }],
      routes: [],
    });

    expect(BridgeMapSchema.parse(expanded).instances[0]?.url).toBe('http://discord:3911');
  });

  it('expands bridge map ${VAR:-default} placeholders from defaults and env overrides', () => {
    const defaultExpanded = expandBridgeMapEnvPlaceholders({
      ...validMap,
      instances: [{ id: 'remy', platform: 'discord', url: 'http://discord:${TEST_BRIDGE_DEFAULT_PORT:-3002}' }],
      routes: [],
    });

    expect(BridgeMapSchema.parse(defaultExpanded).instances[0]?.url).toBe('http://discord:3002');

    process.env.TEST_BRIDGE_DEFAULT_PORT = '4911';
    const envExpanded = expandBridgeMapEnvPlaceholders({
      ...validMap,
      instances: [{ id: 'remy', platform: 'discord', url: 'http://discord:${TEST_BRIDGE_DEFAULT_PORT:-3002}' }],
      routes: [],
    });

    expect(BridgeMapSchema.parse(envExpanded).instances[0]?.url).toBe('http://discord:4911');
  });

  it('fails clearly when a bridge map placeholder has no env value or default', () => {
    expect(() => expandBridgeMapEnvPlaceholders({
      ...validMap,
      instances: [{ id: 'remy', platform: 'discord', url: 'http://discord:${TEST_BRIDGE_REQUIRED_PORT}' }],
      routes: [],
    })).toThrow('Missing environment variable TEST_BRIDGE_REQUIRED_PORT');
  });

  it('parses routes that opt in to relayed-content ingestion', () => {
    const parsed = BridgeMapSchema.parse({
      ...validMap,
      routes: [{ ...validMap.routes[0], ingestRelayed: true }],
    });

    expect(parsed.routes[0]?.ingestRelayed).toBe(true);
  });

  it('parses routes that opt in to media relay', () => {
    const parsed = BridgeMapSchema.parse({
      ...validMap,
      routes: [{ ...validMap.routes[0], mediaRelay: true }],
    });

    expect(parsed.routes[0]?.mediaRelay).toBe(true);
  });

  it('rejects duplicate instance ids', () => {
    const result = BridgeMapSchema.safeParse({
      ...validMap,
      instances: [
        { id: 'remy', platform: 'discord' },
        { id: 'remy', platform: 'whatsapp' },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('accepts telegram and matrix as instance platforms', () => {
    const parsed = BridgeMapSchema.parse({
      ...validMap,
      instances: [
        { id: 'tg', platform: 'telegram' },
        { id: 'mx', platform: 'matrix' },
      ],
      routes: [],
    });

    expect(parsed.instances.map((instance) => instance.platform)).toEqual(['telegram', 'matrix']);
  });

  it('rejects a removed platform value (teams) and names the offending instance', () => {
    const raw = {
      ...validMap,
      instances: [
        { id: 'remy', platform: 'teams', url: 'http://discord:3002' },
        validMap.instances[1],
      ],
    };
    const result = BridgeMapSchema.safeParse(raw);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected parse failure');

    const message = formatBridgeMapZodError(result.error, raw);
    expect(message).toContain('instances entry (id "remy")');
    expect(message).toContain('Invalid');
  });

  it('names the entry by index when the offending entry has no usable id', () => {
    const raw = {
      ...validMap,
      instances: [
        { id: 42, platform: 'teams' },
        validMap.instances[1],
      ],
    };
    const result = BridgeMapSchema.safeParse(raw);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected parse failure');

    const message = formatBridgeMapZodError(result.error, raw);
    expect(message).toContain('instances entry (index 0)');
  });

  it('rejects duplicate route ids', () => {
    const route = validMap.routes[0];
    const result = BridgeMapSchema.safeParse({
      ...validMap,
      routes: [route, { ...route, endpoints: [...route.endpoints] }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects endpoints that reference unknown instances', () => {
    const result = BridgeMapSchema.safeParse({
      ...validMap,
      routes: [{
        ...validMap.routes[0],
        endpoints: [
          { instance: 'remy', chatId: '123' },
          { instance: 'missing', chatId: '456@g.us' },
        ],
      }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects routes where both endpoints are the same chat on the same instance', () => {
    const result = BridgeMapSchema.safeParse({
      ...validMap,
      routes: [{
        ...validMap.routes[0],
        endpoints: [
          { instance: 'remy', chatId: '123' },
          { instance: 'remy', chatId: '123' },
        ],
      }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects any duplicate instance and chat endpoint inside an N-ary route', () => {
    const result = BridgeMapSchema.safeParse({
      ...validMap,
      routes: [{
        id: 'duplicate-endpoint',
        endpoints: [
          { instance: 'remy', chatId: '123' },
          { instance: 'garbanzo', chatId: '456@g.us' },
          { instance: 'remy', chatId: '123' },
        ],
        direction: 'both',
      }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects the same instance appearing twice in one route (bridge distinct instances)', () => {
    const raw = {
      ...validMap,
      routes: [{
        id: 'same-instance-different-chats',
        endpoints: [
          { instance: 'remy', chatId: '123' },
          { instance: 'remy', chatId: '789' },
          { instance: 'garbanzo', chatId: '456@g.us' },
        ],
        direction: 'both',
      }],
    };
    const result = BridgeMapSchema.safeParse(raw);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected parse failure');

    const message = formatBridgeMapZodError(result.error, raw);
    expect(message).toContain('same-instance-different-chats');
    expect(message).toContain('remy');
    expect(message).toContain('at most once per route');
  });

  it('rejects one-way routes whose from value is not one endpoint instance', () => {
    const result = BridgeMapSchema.safeParse({
      ...validMap,
      routes: [{
        ...validMap.routes[0],
        direction: 'one-way',
        from: 'other',
      }],
    });

    expect(result.success).toBe(false);
  });

  it('accepts one-way N-ary routes whose from value names any member instance', () => {
    const parsed = BridgeMapSchema.parse({
      ...validMap,
      routes: [{
        id: 'telegram-out',
        endpoints: [
          { instance: 'remy', chatId: '123' },
          { instance: 'garbanzo', chatId: '456@g.us' },
          { instance: 'telegram-main', chatId: '789' },
        ],
        direction: 'one-way',
        from: 'telegram-main',
      }],
    });

    expect(outboundRoutesForInstance(parsed, 'telegram-main').map((route) => route.id)).toEqual(['telegram-out']);
    expect(outboundRoutesForInstance(parsed, 'remy')).toEqual([]);
  });

  it('filters and finds outbound routes by instance and chat id', () => {
    const parsed = BridgeMapSchema.parse(validMap);

    expect(outboundRoutesForInstance(parsed, 'remy').map((route) => route.id)).toEqual(['band-community']);
    expect(outboundRoutesForInstance(parsed, 'missing')).toEqual([]);
    expect(findOutboundRoute(parsed, 'garbanzo', '456@g.us')?.id).toBe('band-community');
    expect(findOutboundRoute(parsed, 'garbanzo', 'other')).toBeUndefined();
  });

  it('keeps all-routes lookup endpoint-based for diagnostics', () => {
    const parsed = BridgeMapSchema.parse(validMap);

    expect(allRoutesForInstance(parsed, 'garbanzo').map((route) => route.id)).toEqual(['band-community']);
  });

  it('only returns one-way routes for the sending endpoint', () => {
    const parsed = BridgeMapSchema.parse({
      ...validMap,
      routes: [
        {
          id: 'remy-to-garbanzo',
          endpoints: [
            { instance: 'remy', chatId: '123' },
            { instance: 'garbanzo', chatId: '456@g.us' },
          ],
          direction: 'one-way',
          from: 'remy',
        },
        {
          id: 'garbanzo-to-remy',
          endpoints: [
            { instance: 'remy', chatId: '789' },
            { instance: 'garbanzo', chatId: '999@g.us' },
          ],
          direction: 'one-way',
          from: 'garbanzo',
        },
      ],
    });

    expect(outboundRoutesForInstance(parsed, 'remy').map((route) => route.id)).toEqual(['remy-to-garbanzo']);
    expect(outboundRoutesForInstance(parsed, 'garbanzo').map((route) => route.id)).toEqual(['garbanzo-to-remy']);
    expect(allRoutesForInstance(parsed, 'remy').map((route) => route.id)).toEqual([
      'remy-to-garbanzo',
      'garbanzo-to-remy',
    ]);

    expect(findOutboundRoute(parsed, 'remy', '123')?.id).toBe('remy-to-garbanzo');
    expect(findOutboundRoute(parsed, 'remy', '789')).toBeUndefined();
    expect(findOutboundRoute(parsed, 'garbanzo', '999@g.us')?.id).toBe('garbanzo-to-remy');
    expect(findOutboundRoute(parsed, 'garbanzo', '456@g.us')).toBeUndefined();
  });

  it('returns null when the bridge map file is absent', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: vi.fn(() => false) };
    });

    const { loadBridgeMap } = await import('../src/bridge/bridge-map.js');
    expect(loadBridgeMap()).toBeNull();
  });

  it('returns null when the bridge map file is invalid', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() => '{ "instances": []'),
      };
    });

    const { loadBridgeMap } = await import('../src/bridge/bridge-map.js');
    expect(loadBridgeMap()).toBeNull();
  });

  it('loads bridge map files with env placeholders before schema validation', async () => {
    process.env.TEST_BRIDGE_PORT = '4922';
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() => JSON.stringify({
          ...validMap,
          instances: [
            { id: 'remy', platform: 'discord', url: 'http://discord:${TEST_BRIDGE_PORT}' },
            validMap.instances[1],
          ],
        })),
      };
    });

    const { loadBridgeMap } = await import('../src/bridge/bridge-map.js');
    expect(loadBridgeMap()?.instances[0]?.url).toBe('http://discord:4922');
  });

  it('uses the cached map and outbound route direction for media-relay chat lookup', async () => {
    const readFileSyncMock = vi.fn(() => JSON.stringify({
      ...validMap,
      routes: [{ ...validMap.routes[0], mediaRelay: true }],
    }));
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: vi.fn(() => true), readFileSync: readFileSyncMock };
    });

    const { chatHasMediaRelayRoute } = await import('../src/bridge/bridge-map.js');

    expect(chatHasMediaRelayRoute('remy', '123')).toBe(true);
    expect(chatHasMediaRelayRoute('garbanzo', '456@g.us')).toBe(true);
    expect(chatHasMediaRelayRoute('remy', 'missing')).toBe(false);
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the example file valid against the schema', () => {
    const example = JSON.parse(readFileSync('config/bridge-map.example.json', 'utf8')) as unknown;

    expect(() => BridgeMapSchema.parse(expandBridgeMapEnvPlaceholders(example))).not.toThrow();
  });
});
