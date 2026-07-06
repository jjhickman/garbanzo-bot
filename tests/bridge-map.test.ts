process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BridgeMapSchema,
  findRoute,
  routesForInstance,
} from '../src/bridge/bridge-map.js';

const validMap = {
  instances: [
    { id: 'remy', platform: 'discord', url: 'http://discord:3002' },
    { id: 'garbanzo', platform: 'whatsapp', url: 'http://whatsapp:3001' },
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

  it('parses a valid map and applies risk-posture defaults', () => {
    const parsed = BridgeMapSchema.parse(validMap);

    expect(parsed.routes[0]).toMatchObject({
      modeToWhatsApp: 'summary',
      modeToDiscord: 'verbatim',
      relayCommands: false,
    });
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

  it('filters and finds routes by instance and chat id', () => {
    const parsed = BridgeMapSchema.parse(validMap);

    expect(routesForInstance(parsed, 'remy').map((route) => route.id)).toEqual(['band-community']);
    expect(routesForInstance(parsed, 'missing')).toEqual([]);
    expect(findRoute(parsed, 'garbanzo', '456@g.us')?.id).toBe('band-community');
    expect(findRoute(parsed, 'garbanzo', 'other')).toBeUndefined();
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

  it('keeps the example file valid against the schema', () => {
    const example = JSON.parse(readFileSync('config/bridge-map.example.json', 'utf8')) as unknown;

    expect(() => BridgeMapSchema.parse(example)).not.toThrow();
  });
});
