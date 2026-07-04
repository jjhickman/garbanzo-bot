import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

type ComposeService = {
  container_name?: unknown;
  depends_on?: unknown;
  env_file?: unknown;
  environment?: unknown;
  extra_hosts?: unknown;
  ports?: unknown;
  profiles?: unknown;
  volumes?: unknown;
};

type ComposeVolume = {
  name?: unknown;
};

type ComposeFile = {
  services?: Record<string, ComposeService>;
  volumes?: Record<string, ComposeVolume>;
};

type EnvFileEntry = {
  path: string;
  required?: boolean;
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

function envFileEntries(service: ComposeService): EnvFileEntry[] {
  if (!Array.isArray(service.env_file)) return [];

  return service.env_file
    .map((entry): EnvFileEntry | null => {
      if (typeof entry === 'string') return { path: entry };
      if (!isRecord(entry) || typeof entry.path !== 'string') return null;
      return {
        path: entry.path,
        required: typeof entry.required === 'boolean' ? entry.required : undefined,
      };
    })
    .filter((entry): entry is EnvFileEntry => entry !== null);
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

function service(compose: ComposeFile, name: string): ComposeService {
  const value = compose.services?.[name];
  expect(value).toBeDefined();
  return value ?? {};
}

describe('platform-profile compose contract', () => {
  const compose = parseCompose('docker-compose.yml');
  const composeText = readFileSync('docker-compose.yml', 'utf-8');

  it('defines only platform-named bot services and profiles', () => {
    expect(Object.keys(compose.services ?? {}).sort()).toEqual([
      'discord',
      'grafana',
      'prometheus',
      'qdrant',
      'whatsapp',
    ]);

    expect(service(compose, 'qdrant').profiles).toEqual(['discord', 'whatsapp']);
    expect(service(compose, 'discord').profiles).toEqual(['discord']);
    expect(service(compose, 'whatsapp').profiles).toEqual(['whatsapp']);
    expect(service(compose, 'prometheus').profiles).toEqual(['monitoring']);
    expect(service(compose, 'grafana').profiles).toEqual(['monitoring']);

    for (const [name, svc] of Object.entries(compose.services ?? {})) {
      expect(name).not.toBe('remy');
      expect(toStringList(svc.profiles)).not.toContain('remy');
    }

    expect(existsSync('docker-compose.remy.yml')).toBe(false);
  });

  it('layers shared and instance env files with required instance files disabled', () => {
    expect(envFileEntries(service(compose, 'discord'))).toEqual([
      { path: '.env', required: true },
      { path: '.env.discord', required: false },
    ]);
    expect(envFileEntries(service(compose, 'whatsapp'))).toEqual([
      { path: '.env', required: true },
      { path: '.env.whatsapp', required: false },
    ]);
  });

  it('preserves all named Docker volumes byte-for-byte', () => {
    const volumeNames = Object.values(compose.volumes ?? {}).map((volume) => volume.name);

    expect(volumeNames.sort()).toEqual([
      'garbanzo-bot-auth',
      'garbanzo-bot-data',
      'garbanzo-bot-grafana',
      'garbanzo-bot-prometheus',
      'garbanzo-bot-qdrant',
      'garbanzo-bot-remy-data',
    ]);
  });

  it('pins platform identity, health ports, public ports, qdrant dependency, and host gateway', () => {
    const discord = service(compose, 'discord');
    const whatsapp = service(compose, 'whatsapp');

    expect(envEntries(discord)).toEqual(
      expect.arrayContaining(['MESSAGING_PLATFORM=discord', 'HEALTH_PORT=3002']),
    );
    expect(envEntries(whatsapp)).toEqual(
      expect.arrayContaining(['MESSAGING_PLATFORM=whatsapp', 'HEALTH_PORT=3001']),
    );

    expect(toStringList(discord.ports)).toContain('127.0.0.1:3002:3002');
    expect(toStringList(whatsapp.ports)).toContain('0.0.0.0:3001:3001');

    expect(dependsOnEntries(discord)).toContain('qdrant');
    expect(dependsOnEntries(whatsapp)).toContain('qdrant');

    expect(toStringList(discord.extra_hosts)).toContain('host.docker.internal:host-gateway');
    expect(toStringList(whatsapp.extra_hosts)).toContain('host.docker.internal:host-gateway');
  });

  it('keeps platform-specific persisted data mounts', () => {
    expect(toStringList(service(compose, 'discord').volumes)).toEqual(
      expect.arrayContaining([
        'discord_data:/app/data',
        './config/discord-channels.json:/app/config/discord-channels.json:ro',
      ]),
    );
    expect(toStringList(service(compose, 'whatsapp').volumes)).toEqual(
      expect.arrayContaining([
        'baileys_auth:/app/baileys_auth',
        'garbanzo_data:/app/data',
        './config/groups.json:/app/config/groups.json:ro',
      ]),
    );
  });

  it('uses MONITORING_TOKEN for monitoring entrypoint wiring', () => {
    expect(composeText).not.toContain('WHATSAPP_LOGIN_TOKEN');
    expect(envEntries(service(compose, 'prometheus'))).toContain(
      'PROM_BEARER_TOKEN=${MONITORING_TOKEN:-}',
    );
    expect(envEntries(service(compose, 'grafana'))).toContain('MONITORING_TOKEN=${MONITORING_TOKEN:-}');
    expect(String(service(compose, 'prometheus').command)).toContain('PROM_BEARER_TOKEN');
    expect(String(service(compose, 'grafana').command)).toContain('MONITORING_TOKEN');
  });
});
