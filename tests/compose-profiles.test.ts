import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

import { BridgeMapSchema } from '../src/bridge/bridge-map.js';

type ComposeService = {
  command?: unknown;
  container_name?: unknown;
  depends_on?: unknown;
  entrypoint?: unknown;
  env_file?: unknown;
  environment?: unknown;
  extra_hosts?: unknown;
  healthcheck?: unknown;
  mem_limit?: unknown;
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

function parseEnvExample(file: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const delimiterIndex = trimmed.indexOf('=');
    if (delimiterIndex <= 0) continue;

    entries.set(trimmed.slice(0, delimiterIndex), trimmed.slice(delimiterIndex + 1));
  }

  return entries;
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
      'matrix',
      'prometheus',
      'qdrant',
      'rabbitmq',
      'telegram',
      'whatsapp',
    ]);

    expect(service(compose, 'qdrant').profiles).toEqual(['discord', 'whatsapp', 'telegram', 'matrix']);
    expect(service(compose, 'discord').profiles).toEqual(['discord']);
    expect(service(compose, 'whatsapp').profiles).toEqual(['whatsapp']);
    expect(service(compose, 'telegram').profiles).toEqual(['telegram']);
    expect(service(compose, 'matrix').profiles).toEqual(['matrix']);
    expect(service(compose, 'prometheus').profiles).toEqual(['monitoring']);
    expect(service(compose, 'grafana').profiles).toEqual(['monitoring']);
    expect(service(compose, 'rabbitmq').profiles).toEqual(['broker']);

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
    expect(envFileEntries(service(compose, 'telegram'))).toEqual([
      { path: '.env', required: true },
      { path: '.env.telegram', required: false },
    ]);
    expect(envFileEntries(service(compose, 'matrix'))).toEqual([
      { path: '.env', required: true },
      { path: '.env.matrix', required: false },
    ]);
  });

  it('preserves all named Docker volumes byte-for-byte', () => {
    const volumeNames = Object.values(compose.volumes ?? {}).map((volume) => volume.name);

    expect(volumeNames.sort()).toEqual([
      'garbanzo-bot-auth',
      'garbanzo-bot-data',
      'garbanzo-bot-grafana',
      'garbanzo-bot-matrix-data',
      'garbanzo-bot-prometheus',
      'garbanzo-bot-qdrant',
      'garbanzo-bot-rabbitmq',
      'garbanzo-bot-remy-data',
      'garbanzo-bot-telegram-data',
    ]);
  });

  it('pins platform identity, env-driven health ports, qdrant dependency, and host gateway', () => {
    const qdrant = service(compose, 'qdrant');
    const discord = service(compose, 'discord');
    const whatsapp = service(compose, 'whatsapp');
    const telegram = service(compose, 'telegram');

    expect(envEntries(qdrant)).toContain('QDRANT__SERVICE__HTTP_PORT=${QDRANT_PORT:-6333}');
    expect(String((qdrant.healthcheck as { test?: unknown })?.test)).toContain(
      '$${QDRANT__SERVICE__HTTP_PORT:-6333}',
    );

    expect(envEntries(discord)).toEqual(
      expect.arrayContaining([
        'MESSAGING_PLATFORM=discord',
        'HEALTH_PORT=${DISCORD_HEALTH_PORT:-3002}',
        'QDRANT_URL=${QDRANT_URL:-http://qdrant:${QDRANT_PORT:-6333}}',
      ]),
    );
    expect(envEntries(whatsapp)).toEqual(
      expect.arrayContaining([
        'MESSAGING_PLATFORM=whatsapp',
        'HEALTH_PORT=${WHATSAPP_HEALTH_PORT:-3001}',
        'QDRANT_URL=${QDRANT_URL:-http://qdrant:${QDRANT_PORT:-6333}}',
      ]),
    );
    expect(envEntries(telegram)).toEqual(
      expect.arrayContaining([
        'MESSAGING_PLATFORM=telegram',
        'HEALTH_PORT=${TELEGRAM_HEALTH_PORT:-3005}',
        'QDRANT_URL=${QDRANT_URL:-http://qdrant:${QDRANT_PORT:-6333}}',
      ]),
    );

    const matrix = service(compose, 'matrix');
    expect(envEntries(matrix)).toEqual(
      expect.arrayContaining([
        'MESSAGING_PLATFORM=matrix',
        'HEALTH_PORT=${MATRIX_HEALTH_PORT:-3004}',
        'QDRANT_URL=${QDRANT_URL:-http://qdrant:${QDRANT_PORT:-6333}}',
      ]),
    );

    expect(toStringList(discord.ports)).toContain(
      '127.0.0.1:${DISCORD_HEALTH_PORT:-3002}:${DISCORD_HEALTH_PORT:-3002}',
    );
    expect(toStringList(whatsapp.ports)).toContain(
      '0.0.0.0:${WHATSAPP_HEALTH_PORT:-3001}:${WHATSAPP_HEALTH_PORT:-3001}',
    );
    expect(toStringList(telegram.ports)).toContain(
      '127.0.0.1:${TELEGRAM_HEALTH_PORT:-3005}:${TELEGRAM_HEALTH_PORT:-3005}',
    );
    expect(toStringList(matrix.ports)).toContain(
      '127.0.0.1:${MATRIX_HEALTH_PORT:-3004}:${MATRIX_HEALTH_PORT:-3004}',
    );

    expect(dependsOnEntries(discord)).toContain('qdrant');
    expect(dependsOnEntries(whatsapp)).toContain('qdrant');
    expect(dependsOnEntries(telegram)).toContain('qdrant');
    expect(dependsOnEntries(matrix)).toContain('qdrant');

    expect(toStringList(discord.extra_hosts)).toContain('host.docker.internal:host-gateway');
    expect(toStringList(whatsapp.extra_hosts)).toContain('host.docker.internal:host-gateway');
    expect(toStringList(telegram.extra_hosts)).toContain('host.docker.internal:host-gateway');
    expect(toStringList(matrix.extra_hosts)).toContain('host.docker.internal:host-gateway');
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
    expect(toStringList(service(compose, 'telegram').volumes)).toEqual(
      expect.arrayContaining([
        'telegram_data:/app/data',
        './config/telegram-chats.json:/app/config/telegram-chats.json:ro',
      ]),
    );
    expect(toStringList(service(compose, 'matrix').volumes)).toEqual(
      expect.arrayContaining([
        'matrix_data:/app/data',
        './config/matrix-rooms.json:/app/config/matrix-rooms.json:ro',
      ]),
    );
  });

  it('ro-mounts the bridge map on all bot services', () => {
    expect(toStringList(service(compose, 'discord').volumes)).toContain(
      './config/bridge-map.json:/app/config/bridge-map.json:ro',
    );
    expect(toStringList(service(compose, 'whatsapp').volumes)).toContain(
      './config/bridge-map.json:/app/config/bridge-map.json:ro',
    );
    expect(toStringList(service(compose, 'telegram').volumes)).toContain(
      './config/bridge-map.json:/app/config/bridge-map.json:ro',
    );
    expect(toStringList(service(compose, 'matrix').volumes)).toContain(
      './config/bridge-map.json:/app/config/bridge-map.json:ro',
    );
  });

  it('uses MONITORING_TOKEN for monitoring entrypoint wiring', () => {
    expect(composeText).not.toContain('WHATSAPP_LOGIN_TOKEN');
    const prometheus = service(compose, 'prometheus');

    expect(envEntries(prometheus)).toEqual(
      expect.arrayContaining([
        'PROM_BEARER_TOKEN=${MONITORING_TOKEN:-}',
        'DISCORD_HEALTH_PORT=${DISCORD_HEALTH_PORT:-3002}',
        'WHATSAPP_HEALTH_PORT=${WHATSAPP_HEALTH_PORT:-3001}',
        'TELEGRAM_HEALTH_PORT=${TELEGRAM_HEALTH_PORT:-3005}',
        'MATRIX_HEALTH_PORT=${MATRIX_HEALTH_PORT:-3004}',
        'PROMETHEUS_PORT=${PROMETHEUS_PORT:-9090}',
      ]),
    );
    expect(envEntries(service(compose, 'grafana'))).toContain('MONITORING_TOKEN=${MONITORING_TOKEN:-}');
    expect(String(prometheus.command)).toContain('PROM_BEARER_TOKEN');
    expect(String(prometheus.command)).toContain('/prometheus/prometheus.yml');
    expect(String(prometheus.command)).toContain('DISCORD_HEALTH_PORT');
    expect(String(service(compose, 'grafana').command)).toContain('MONITORING_TOKEN');
    expect(toStringList(prometheus.ports)).toContain(
      '127.0.0.1:${PROMETHEUS_PORT:-9090}:${PROMETHEUS_PORT:-9090}',
    );
    expect(toStringList(service(compose, 'grafana').ports)).toContain(
      '0.0.0.0:${GRAFANA_PORT:-3000}:${GRAFANA_PORT:-3000}',
    );
  });

  it('wires the broker profile rabbitmq service with a refusal entrypoint and localhost-only management UI', () => {
    const rabbitmq = service(compose, 'rabbitmq');

    expect(rabbitmq.container_name).toBe('garbanzo-rabbitmq');
    expect(rabbitmq.mem_limit).toBe('400m');
    expect(rabbitmq.healthcheck).toBeDefined();
    expect(String((rabbitmq.healthcheck as { test?: unknown })?.test)).toContain('rabbitmq-diagnostics');

    const ports = toStringList(rabbitmq.ports);
    expect(ports).toContain('127.0.0.1:${RABBITMQ_MGMT_PORT:-15672}:${RABBITMQ_MGMT_PORT:-15672}');
    expect(ports.some((port) => port.includes('5672:5672'))).toBe(false);
    expect(composeText).not.toMatch(/^\s*-\s*"?[\d.]*:?5672:5672"?\s*$/m);

    expect(envEntries(rabbitmq)).toEqual(
      expect.arrayContaining([
        'RABBITMQ_DEFAULT_USER=${BRIDGE_BROKER_USER:-garbanzo}',
        'RABBITMQ_DEFAULT_PASS=${BRIDGE_BROKER_PASSWORD:-}',
        'RABBITMQ_MGMT_PORT=${RABBITMQ_MGMT_PORT:-15672}',
      ]),
    );
    expect(String(rabbitmq.command)).toContain('BRIDGE_BROKER_PASSWORD');
    expect(String(rabbitmq.command)).toContain('management.tcp.port');
    expect(String(rabbitmq.command)).toContain('Set BRIDGE_BROKER_PASSWORD in .env to enable the broker profile');
  });

  it('preserves the six v2 volume names byte-identical', () => {
    const volumeNames = Object.values(compose.volumes ?? {}).map((volume) => volume.name);

    for (const name of [
      'garbanzo-bot-auth',
      'garbanzo-bot-data',
      'garbanzo-bot-remy-data',
      'garbanzo-bot-qdrant',
      'garbanzo-bot-prometheus',
      'garbanzo-bot-grafana',
    ]) {
      expect(volumeNames).toContain(name);
    }
  });

  it('validates the committed bridge-map.json against the bridge map schema', () => {
    const bridgeMap = JSON.parse(readFileSync('config/bridge-map.json', 'utf-8')) as unknown;
    expect(() => BridgeMapSchema.parse(bridgeMap)).not.toThrow();
    expect(BridgeMapSchema.parse(bridgeMap)).toEqual({ instances: [], routes: [] });
  });
});

describe('layered env example coherence', () => {
  const sharedExample = parseEnvExample('.env.example');
  const discordExample = parseEnvExample('.env.discord.example');
  const whatsappExample = parseEnvExample('.env.whatsapp.example');
  const telegramExample = parseEnvExample('.env.telegram.example');
  const matrixExample = parseEnvExample('.env.matrix.example');
  const discordExampleText = readFileSync('.env.discord.example', 'utf-8');
  const sharedExampleText = readFileSync('.env.example', 'utf-8');

  it('keeps shared and instance examples from defining the same keys', () => {
    for (const [instanceName, instanceExample] of [
      ['discord', discordExample],
      ['whatsapp', whatsappExample],
      ['telegram', telegramExample],
      ['matrix', matrixExample],
    ] as const) {
      const duplicatedKeys = [...instanceExample.keys()].filter((key) => sharedExample.has(key));

      expect(duplicatedKeys, `${instanceName} example duplicates shared keys`).toEqual([]);
    }
  });

  it('keeps compose profile and monitoring token guidance in the shared example', () => {
    expect(sharedExample.has('COMPOSE_PROFILES')).toBe(true);
    expect(sharedExample.has('MONITORING_TOKEN')).toBe(true);
  });

  it('keeps Discord-only guidance in the Discord example', () => {
    expect(discordExampleText).toContain('WHISPER_URL');
  });

  it('keeps OWNER_JID scoped to the WhatsApp example', () => {
    expect(whatsappExample.has('OWNER_JID')).toBe(true);
    expect(sharedExample.has('OWNER_JID')).toBe(false);
    expect(discordExample.has('OWNER_JID')).toBe(false);
  });

  it('keeps Telegram credentials scoped to the Telegram example', () => {
    expect(telegramExample.has('TELEGRAM_BOT_TOKEN')).toBe(true);
    expect(telegramExample.has('TELEGRAM_OWNER_ID')).toBe(true);
    expect(telegramExample.get('TELEGRAM_CHAT_SCOPE')).toBe('configured');
    expect(sharedExample.has('TELEGRAM_BOT_TOKEN')).toBe(false);
  });

  it('keeps Matrix credentials scoped to the Matrix example', () => {
    expect(matrixExample.has('MATRIX_HOMESERVER_URL')).toBe(true);
    expect(matrixExample.has('MATRIX_ACCESS_TOKEN')).toBe(true);
    expect(matrixExample.has('MATRIX_OWNER_ID')).toBe(true);
    expect(matrixExample.get('MATRIX_CHAT_SCOPE')).toBe('configured');
    expect(sharedExample.has('MATRIX_ACCESS_TOKEN')).toBe(false);
  });

  it('removes the retired Remy env example', () => {
    expect(existsSync('.env.remy.example')).toBe(false);
  });

  it('documents bridging (v3) keys in the shared example, commented and off by default', () => {
    for (const key of [
      'BRIDGE_ENABLED',
      'INSTANCE_ID',
      'BRIDGE_TRANSPORT',
      'BRIDGE_BROKER_URL',
      'BRIDGE_BROKER_USER',
      'BRIDGE_BROKER_PASSWORD',
      'BRIDGE_SUMMARY_INTERVAL_MINUTES',
      'BRIDGE_MAX_TEXT',
      'SHARED_MEMORY_ENABLED',
      'QDRANT_SHARED_COLLECTION',
    ]) {
      expect(sharedExampleText, `${key} missing from .env.example`).toContain(key);
    }

    // Documented off-by-default: no uncommented BRIDGE_ENABLED=true / SHARED_MEMORY_ENABLED=true line.
    expect(sharedExampleText).not.toMatch(/^BRIDGE_ENABLED=true/m);
    expect(sharedExampleText).not.toMatch(/^SHARED_MEMORY_ENABLED=true/m);
  });
});
