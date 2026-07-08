process.env.MESSAGING_PLATFORM ??= 'matrix';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.MATRIX_HOMESERVER_URL ??= 'https://matrix.example.org';
process.env.MATRIX_ACCESS_TOKEN ??= 'test_matrix_token';
process.env.MATRIX_OWNER_ID ??= '@owner:example.org';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalRoomsConfigPath = process.env.MATRIX_ROOMS_CONFIG_PATH;
const originalMatrixOwnerId = process.env.MATRIX_OWNER_ID;

function writeFixture(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'garbanzo-matrix-config-'));
  const path = join(dir, 'matrix-rooms.json');
  writeFileSync(path, JSON.stringify(body), 'utf8');
  return path;
}

function writeMalformedFixture(raw: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'garbanzo-matrix-config-'));
  const path = join(dir, 'matrix-rooms.json');
  writeFileSync(path, raw, 'utf8');
  return path;
}

async function importMatrixConfig(path: string, ownerId = '@owner:example.org') {
  vi.resetModules();
  process.env.MATRIX_ROOMS_CONFIG_PATH = path;
  process.env.MATRIX_OWNER_ID = ownerId;
  return import('../src/platforms/matrix/matrix-config.js');
}

describe('Matrix room config', () => {
  afterEach(() => {
    vi.resetModules();
    if (originalRoomsConfigPath === undefined) {
      delete process.env.MATRIX_ROOMS_CONFIG_PATH;
    } else {
      process.env.MATRIX_ROOMS_CONFIG_PATH = originalRoomsConfigPath;
    }
    if (originalMatrixOwnerId === undefined) {
      delete process.env.MATRIX_OWNER_ID;
    } else {
      process.env.MATRIX_OWNER_ID = originalMatrixOwnerId;
    }
  });

  describe('fail-soft loader trio', () => {
    it('falls back to all-disabled when the config file is missing', async () => {
      const matrixConfig = await importMatrixConfig(join(tmpdir(), 'missing-matrix-rooms.json'));

      expect(matrixConfig.isMatrixRoomEnabled('!room:any')).toBe(false);
      expect(matrixConfig.matrixRoomRequiresMention('!room:any')).toBe(true);
      expect(matrixConfig.isMatrixFeatureEnabled('!room:any', 'events')).toBe(false);
      expect(matrixConfig.getMatrixRoomName('!room:any')).toBeUndefined();
    });

    it('falls back to all-disabled when the config file is malformed JSON', async () => {
      const path = writeMalformedFixture('{ this is not valid json');
      const matrixConfig = await importMatrixConfig(path);

      expect(matrixConfig.isMatrixRoomEnabled('!room:any')).toBe(false);
      expect(matrixConfig.matrixRoomRequiresMention('!room:any')).toBe(true);

      rmSync(join(path, '..'), { recursive: true, force: true });
    });

    it('falls back to all-disabled when the config fails schema validation', async () => {
      const path = writeFixture({ rooms: { '!room:example.org': { enabled: 'not-a-boolean' } } });
      const matrixConfig = await importMatrixConfig(path);

      expect(matrixConfig.isMatrixRoomEnabled('!room:example.org')).toBe(false);

      rmSync(join(path, '..'), { recursive: true, force: true });
    });
  });

  it('loads enabled rooms, requireMention, feature gates, and persona', async () => {
    const path = writeFixture({
      ownerId: '@file-owner:example.org',
      rooms: {
        '!enabled:example.org': { name: 'general', requireMention: false, persona: 'bea' },
        '!gated:example.org': { name: 'events', enabledFeatures: ['events'] },
        '!disabled:example.org': { name: 'quiet', enabled: false },
      },
    });
    const matrixConfig = await importMatrixConfig(path);

    expect(matrixConfig.isMatrixRoomEnabled('!enabled:example.org')).toBe(true);
    expect(matrixConfig.isMatrixRoomEnabled('!disabled:example.org')).toBe(false);
    expect(matrixConfig.matrixRoomRequiresMention('!enabled:example.org')).toBe(false);
    expect(matrixConfig.matrixRoomRequiresMention('!gated:example.org')).toBe(true);
    expect(matrixConfig.getMatrixRoomName('!enabled:example.org')).toBe('general');
    expect(matrixConfig.getMatrixRoomPersona('!enabled:example.org')).toBe('bea');
    expect(matrixConfig.isMatrixFeatureEnabled('!enabled:example.org', 'venues')).toBe(true);
    expect(matrixConfig.isMatrixFeatureEnabled('!gated:example.org', 'events')).toBe(true);
    expect(matrixConfig.isMatrixFeatureEnabled('!gated:example.org', 'venues')).toBe(false);

    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('keeps config/matrix-rooms.example.json valid against the loader schema', async () => {
    const { MatrixRoomsConfigSchema } = await import('../src/platforms/matrix/matrix-config.js');
    const example = JSON.parse(readFileSync(resolve('config/matrix-rooms.example.json'), 'utf8')) as unknown;

    expect(MatrixRoomsConfigSchema.safeParse(example).success).toBe(true);
  });
});
