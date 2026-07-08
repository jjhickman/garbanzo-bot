import { constants, existsSync, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';

const DEFAULT_HEALTH_PORT = 3001;
const DEFAULT_PLATFORM = 'discord';
const REGISTRY_URL = 'https://registry.npmjs.org/garbanzo-bot';
const REGISTRY_TIMEOUT_MS = 1500;

export type DoctorMode = 'repo' | 'packaged' | 'env-set';

export interface LayeredEnvResult {
  env: NodeJS.ProcessEnv;
  loadedFiles: string[];
  platform: string;
}

export interface DoctorOptions {
  packageRoot: string;
  homeDir: string;
  mode: DoctorMode;
  env?: NodeJS.ProcessEnv;
  skipRegistry?: boolean;
}

export interface BinaryStatus {
  present: boolean;
  path: string | null;
  source: 'path' | 'env' | 'missing';
}

export interface DoctorReport {
  node: {
    version: string;
    requirement: string;
    ok: boolean;
  };
  paths: {
    mode: DoctorMode;
    packageRoot: string;
    home: string;
  };
  configFiles: Record<string, boolean>;
  binaries: Record<'ffmpeg' | 'yt-dlp' | 'piper', BinaryStatus>;
  providers: Record<'openrouter' | 'anthropic' | 'openai' | 'gemini' | 'bedrock', boolean>;
  healthPort: {
    port: number;
    available: boolean;
    error: string | null;
  };
  version: {
    current: string;
    latest: string;
    status: 'ok' | 'not-yet-published' | 'offline' | 'skipped';
  };
}

function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const exportless = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
    const separatorIndex = exportless.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = exportless.slice(0, separatorIndex).trim();
    let value = exportless.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    const quote = value.at(0);
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const commentIndex = value.indexOf(' #');
      if (commentIndex >= 0) value = value.slice(0, commentIndex).trimEnd();
    }

    parsed[key] = value;
  }

  return parsed;
}

function readEnvFile(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  const contents = readFileSync(path, 'utf8');
  return parseEnvFile(contents);
}

export function parseLayeredEnv(homeDir: string, realEnv: NodeJS.ProcessEnv = process.env): LayeredEnvResult {
  const env: NodeJS.ProcessEnv = {};
  const loadedFiles: string[] = [];

  const basePath = join(homeDir, '.env');
  const baseEnv = readEnvFile(basePath);
  if (baseEnv) {
    Object.assign(env, baseEnv);
    loadedFiles.push(basePath);
  }

  const platform = realEnv.MESSAGING_PLATFORM ?? env.MESSAGING_PLATFORM ?? DEFAULT_PLATFORM;
  const platformPath = join(homeDir, `.env.${platform}`);
  const platformEnv = readEnvFile(platformPath);
  if (platformEnv) {
    Object.assign(env, platformEnv);
    loadedFiles.push(platformPath);
  }

  Object.assign(env, realEnv);

  return { env, loadedFiles, platform };
}

function packageManagerEngineRequirement(packageRoot: string): string {
  try {
    const json = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    return json.engines?.node ?? '>=20.0.0';
  } catch {
    return '>=20.0.0';
  }
}

function currentPackageVersion(packageRoot: string): string {
  try {
    const json = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return json.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseVersion(version: string): [number, number, number] {
  const match = version.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function satisfiesEngine(nodeVersion: string, requirement: string): boolean {
  const minMatch = requirement.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  if (!minMatch) return true;

  const actual = parseVersion(nodeVersion);
  const expected: [number, number, number] = [Number(minMatch[1]), Number(minMatch[2]), Number(minMatch[3])];

  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] > expected[index]) return true;
    if (actual[index] < expected[index]) return false;
  }
  return true;
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateExecutableNames(name: string): string[] {
  if (process.platform !== 'win32') return [name];
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean);
  return extensions.map((extension) => `${name}${extension.toLowerCase()}`).concat(extensions.map((extension) => `${name}${extension}`), name);
}

async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const pathDir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const candidateName of candidateExecutableNames(name)) {
      const candidatePath = join(pathDir, candidateName);
      if (await executableExists(candidatePath)) return candidatePath;
    }
  }
  return null;
}

async function binaryStatus(name: string, env: NodeJS.ProcessEnv, envKey?: string): Promise<BinaryStatus> {
  const envPath = envKey ? env[envKey]?.trim() : undefined;
  if (envPath) {
    return {
      present: await executableExists(envPath),
      path: envPath,
      source: 'env',
    };
  }

  const path = await findOnPath(name, env);
  return {
    present: path !== null,
    path,
    source: path ? 'path' : 'missing',
  };
}

function configExistence(homeDir: string): Record<string, boolean> {
  const files = [
    '.env',
    '.env.discord',
    '.env.whatsapp',
    '.env.telegram',
    '.env.matrix',
    'config/groups.json',
    'config/discord-channels.json',
    'config/telegram-chats.json',
    'config/matrix-rooms.json',
    'config/bridge-map.json',
    'config/rag-sources.json',
  ];

  return Object.fromEntries(files.map((file) => [file, existsSync(join(homeDir, file))]));
}

function providerBooleans(env: NodeJS.ProcessEnv): DoctorReport['providers'] {
  return {
    openrouter: Boolean(env.OPENROUTER_API_KEY),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    // The runtime counts OAuth mode as configured even without a key
    openai: Boolean(env.OPENAI_API_KEY) || env.OPENAI_AUTH_MODE === 'oauth',
    gemini: Boolean(env.GEMINI_API_KEY),
    bedrock: Boolean(env.BEDROCK_MODEL_ID),
  };
}

function parseHealthPort(env: NodeJS.ProcessEnv): number {
  // Mirror the runtime schema (min 1): values the runtime would reject
  // must not make doctor report a different, "available" port.
  const candidate = Number(env.HEALTH_PORT ?? DEFAULT_HEALTH_PORT);
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) return DEFAULT_HEALTH_PORT;
  return candidate;
}

function probeHealthPort(port: number, bindHost: string): Promise<DoctorReport['healthPort']> {
  return new Promise((resolveProbe) => {
    const server = createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      resolveProbe({ port, available: false, error: err.code ?? err.message });
    });
    server.listen(port, bindHost, () => {
      server.close(() => {
        resolveProbe({ port, available: true, error: null });
      });
    });
  });
}

function latestRegistryVersion(): Promise<{ latest: string; status: DoctorReport['version']['status'] }> {
  return new Promise((resolveRegistry) => {
    const req = request(REGISTRY_URL, { method: 'GET', timeout: REGISTRY_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 404) {
          resolveRegistry({ latest: 'not yet published', status: 'not-yet-published' });
          return;
        }
        if (res.statusCode !== 200) {
          resolveRegistry({ latest: `offline (${res.statusCode ?? 'unknown status'})`, status: 'offline' });
          return;
        }
        try {
          const parsed = JSON.parse(body) as { 'dist-tags'?: { latest?: string } };
          resolveRegistry({ latest: parsed['dist-tags']?.latest ?? 'unknown', status: 'ok' });
        } catch {
          resolveRegistry({ latest: 'offline (invalid registry response)', status: 'offline' });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolveRegistry({ latest: 'offline (registry timeout)', status: 'offline' });
    });
    req.on('error', () => {
      resolveRegistry({ latest: 'offline', status: 'offline' });
    });
    req.end();
  });
}

export async function collectDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const layered = parseLayeredEnv(options.homeDir, options.env ?? process.env);
  const requirement = packageManagerEngineRequirement(options.packageRoot);
  const nodeVersion = process.version;
  const version = options.skipRegistry
    ? { latest: 'skipped', status: 'skipped' as const }
    : await latestRegistryVersion();

  return {
    node: {
      version: nodeVersion,
      requirement,
      ok: satisfiesEngine(nodeVersion, requirement),
    },
    paths: {
      mode: options.mode,
      packageRoot: options.packageRoot,
      home: options.homeDir,
    },
    configFiles: configExistence(options.homeDir),
    binaries: {
      ffmpeg: await binaryStatus('ffmpeg', layered.env),
      'yt-dlp': await binaryStatus(layered.env.YT_DLP_BIN ?? 'yt-dlp', layered.env, 'YT_DLP_BIN'),
      piper: await binaryStatus('piper', layered.env, 'PIPER_BIN'),
    },
    providers: providerBooleans(layered.env),
    healthPort: await probeHealthPort(
      parseHealthPort(layered.env),
      layered.env.HEALTH_BIND_HOST?.trim() || '127.0.0.1',
    ),
    version: {
      current: currentPackageVersion(options.packageRoot),
      latest: version.latest,
      status: version.status,
    },
  };
}

function formatBoolean(value: boolean): string {
  return value ? 'true' : 'false';
}

function formatBinary(status: BinaryStatus): string {
  if (!status.present) return `missing source=${status.source}`;
  return `present path=${status.path ?? ''} source=${status.source}`;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    'Garbanzo Doctor',
    '',
    '[node]',
    `version=${report.node.version}`,
    `requirement=${report.node.requirement}`,
    `ok=${formatBoolean(report.node.ok)}`,
    '',
    '[paths]',
    `mode=${report.paths.mode}`,
    `packageRoot=${report.paths.packageRoot}`,
    `home=${report.paths.home}`,
    '',
    '[config-files]',
  ];

  for (const [file, exists] of Object.entries(report.configFiles)) {
    lines.push(`${file}=${exists ? 'present' : 'missing'}`);
  }

  lines.push(
    '',
    '[binaries]',
    `ffmpeg=${formatBinary(report.binaries.ffmpeg)}`,
    `yt-dlp=${formatBinary(report.binaries['yt-dlp'])}`,
    `piper=${formatBinary(report.binaries.piper)}`,
    '',
    '[providers]',
    `openrouter=${formatBoolean(report.providers.openrouter)}`,
    `anthropic=${formatBoolean(report.providers.anthropic)}`,
    `openai=${formatBoolean(report.providers.openai)}`,
    `gemini=${formatBoolean(report.providers.gemini)}`,
    `bedrock=${formatBoolean(report.providers.bedrock)}`,
    '',
    '[health-port]',
    `port=${report.healthPort.port}`,
    `available=${formatBoolean(report.healthPort.available)}`,
    `error=${report.healthPort.error ?? ''}`,
    '',
    '[version]',
    `current=${report.version.current}`,
    `latest=${report.version.latest}`,
    `status=${report.version.status}`,
    '',
  );

  return `${lines.join('\n')}`;
}
