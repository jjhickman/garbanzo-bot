import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

type ComposeService = {
  depends_on?: unknown;
  env_file?: unknown;
  environment?: unknown;
  image?: unknown;
  logging?: unknown;
  ports?: unknown;
  restart?: unknown;
  volumes?: unknown;
};

type ComposeFile = {
  services?: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};

function parseCompose(file: string): ComposeFile {
  const parsed = load(readFileSync(file, 'utf-8'));
  expect(isRecord(parsed)).toBe(true);
  return parsed as ComposeFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function envEntries(service: ComposeService): string[] {
  if (Array.isArray(service.environment)) {
    return service.environment.filter((item): item is string => typeof item === 'string');
  }

  if (isRecord(service.environment)) {
    return Object.entries(service.environment).map(([key, value]) => `${key}=${String(value)}`);
  }

  return [];
}

function dependsOnEntries(service: ComposeService): string[] {
  if (Array.isArray(service.depends_on)) {
    return service.depends_on.filter((item): item is string => typeof item === 'string');
  }

  if (isRecord(service.depends_on)) {
    return Object.keys(service.depends_on);
  }

  return [];
}

describe('Remy compose overlay', () => {
  it('adds an isolated Remy Discord service that reuses the base qdrant service', () => {
    const base = parseCompose('docker-compose.yml');
    const overlay = parseCompose('docker-compose.remy.yml');
    const garbanzo = base.services?.garbanzo;
    const remy = overlay.services?.remy;

    expect(garbanzo).toBeDefined();
    expect(remy).toBeDefined();
    expect(overlay.services?.qdrant).toBeUndefined();

    expect(remy?.image).toBe(garbanzo?.image);
    expect(remy?.restart).toBe(garbanzo?.restart);
    expect(remy?.logging).toEqual(garbanzo?.logging);

    expect(toStringList(remy?.env_file)).toContain('.env.remy');
    expect(envEntries(remy ?? {})).toEqual(
      expect.arrayContaining([
        'MESSAGING_PLATFORM=discord',
        'HEALTH_PORT=3002',
        'QDRANT_COLLECTION=remy_memory',
      ]),
    );

    expect(toStringList(remy?.ports)).toContain('127.0.0.1:3002:3002');
    expect(toStringList(garbanzo?.ports)).toContain('0.0.0.0:3001:3001');
    expect(toStringList(remy?.ports).join('\n')).not.toContain(':3001:');

    const remyVolumes = toStringList(remy?.volumes);
    expect(remyVolumes).toContain('remy_data:/app/data');
    expect(remyVolumes).toContain('./config/discord-channels.json:/app/config/discord-channels.json:ro');
    expect(remyVolumes.join('\n')).not.toContain('garbanzo_data:/app/data');

    expect(dependsOnEntries(remy ?? {})).toContain('qdrant');
    expect(overlay.volumes).toHaveProperty('remy_data');

    expect(envEntries(remy ?? {})).not.toContain('QDRANT_COLLECTION=garbanzo_memory');
  });

  it('documents the required Remy environment values without secrets', () => {
    const envExample = readFileSync('.env.remy.example', 'utf-8');

    expect(envExample).toContain('MESSAGING_PLATFORM=discord');
    expect(envExample).toMatch(/^DISCORD_BOT_TOKEN=$/m);
    expect(envExample).toMatch(/^DISCORD_OWNER_ID=$/m);
    expect(envExample).toContain('BAND_FEATURES_ENABLED=true');
    expect(envExample).toContain('QDRANT_COLLECTION=remy_memory');
    expect(envExample).toContain('HEALTH_PORT=3002');
  });
});
