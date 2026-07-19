import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

import { parse as parseDotenv } from 'dotenv';

import { AI_PROVIDER_ORDER_VALUES, parseConfig } from '../../utils/config/parse-config.js';
import { applyEnvLayers } from '../../utils/config/shared.js';
import {
  DEFAULT_MESSAGING_PLATFORM,
  DISCORD_FIELDS,
  MATRIX_FIELDS,
  mergeEnvFileContent,
  MESSAGING_PLATFORMS,
  OPENAI_AUTH_MODES,
  SHARED_FIELDS,
  TELEGRAM_FIELDS,
  WHATSAPP_FIELDS,
  WHATSAPP_LOGIN_MODES,
  type SetupField,
} from '../../config-core/fields.js';
import { writeFileWithBackupAtomic } from '../../config-core/writers.js';
import { isSecretKey } from '../../config-core/secret-classifier.js';
import { writeJsonWithBackupAtomic } from '../../config-core/writers.js';
import { appendConfigAudit, writeRecoveryNote } from './audit.js';
import {
  applyStagedBundle,
  bundlePreconditionsMatch,
  buildExportBundle,
  captureBundlePreconditions,
  envWithoutRedactedPlaceholders,
  IMPORT_LIMITS,
  pruneStaleStaging,
  readStagedBundle,
  stageBundle,
  restoreJsonPlaceholders,
  validateBundleLimits,
  type ConfigBundle,
  type BundlePreconditions,
} from './bundle.js';
import { ENV_FILE_NAMES, readEnvSnapshot, writeEnvUpdate } from './env-files.js';
import {
  CONFIG_FILE_NAMES,
  isConfigFileName,
  maskJsonSecrets,
  validateConfigFile,
  zodIssues,
  type ConfigFileName,
} from './json-config.js';
import { createSpaAssets, CSP, FAVICON_SVG } from './shell.js';
import { runWizard } from './wizard.js';

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const BODY_LIMIT = IMPORT_LIMITS.compressedBytes;

export const WIZARD_ARG_ALLOWLIST: ReadonlySet<string> = new Set([
  '--discord-channel-ids',
  '--discord-channel-name',
  '--telegram-chat-ids',
  '--telegram-chat-name',
  '--matrix-room-ids',
  '--matrix-room-name',
  '--group-id',
  '--group-name',
]);

export interface ConfigServiceOptions {
  root: string;
  port?: number;
  idleTtlMs?: number;
  print?: (message: string) => void;
  webDist?: string;
}

export interface ConfigServiceHandle {
  port: number;
  root: string;
  entryToken: string;
  closed: Promise<void>;
  close(): Promise<void>;
}

type JsonRecord = Record<string, unknown>;

function safeEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length);
  return token.length > 0 ? token : null;
}

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(value)}\n`);
}

async function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const timer = setTimeout(() => reject(new Error('request-timeout')), IMPORT_LIMITS.timeoutMs);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit && !failed) {
        failed = true;
        clearTimeout(timer);
        reject(new Error('compressed-size-limit'));
        return;
      }
      if (!failed) chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (!failed) resolveBody(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function readJson(req: IncomingMessage): Promise<{ value: JsonRecord; bytes: number }> {
  const body = await readBody(req);
  const value = JSON.parse(body.toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required');
  return { value: value as JsonRecord, bytes: body.length };
}

function parseMultipartBundle(contentType: string, body: Buffer): ConfigBundle {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
  if (!boundary) throw new Error('multipart boundary required');
  const raw = body.toString('utf8');
  const part = raw.split(`--${boundary}`).find((candidate) => /name="file"|filename=/i.test(candidate));
  if (!part) throw new Error('multipart file field required');
  const separator = part.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
  const start = part.indexOf(separator);
  if (start < 0) throw new Error('malformed multipart upload');
  const content = part.slice(start + separator.length).replace(/\r?\n--?$/, '').replace(/\r?\n$/, '');
  return JSON.parse(content) as ConfigBundle;
}

const CONFIG_PATH_KEYS: Partial<Record<string, string>> = {
  'discord-channels': 'DISCORD_CHANNELS_CONFIG_PATH',
  'telegram-chats': 'TELEGRAM_CHATS_CONFIG_PATH',
  'matrix-rooms': 'MATRIX_ROOMS_CONFIG_PATH',
};
const CONFIG_PATH_PLATFORMS: Partial<Record<string, string>> = {
  'discord-channels': 'discord',
  'telegram-chats': 'telegram',
  'matrix-rooms': 'matrix',
};

function configFilePath(root: string, name: string): string {
  const platform = CONFIG_PATH_PLATFORMS[name];
  const env = platform
    ? applyEnvLayers({ baseDir: root, env: {}, realEnv: {}, platform }).env
    : readEnvSnapshot(root).values;
  const configured = CONFIG_PATH_KEYS[name] ? env[CONFIG_PATH_KEYS[name] as string] : undefined;
  const path = configured
    ? (isAbsolute(configured) ? resolve(configured) : resolve(root, configured))
    : resolve(root, 'config', `${name}.json`);
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`${CONFIG_PATH_KEYS[name] ?? name} points outside the managed config root`);
  }
  return path;
}

function effectiveConfigPaths(root: string): Record<string, string> {
  return Object.fromEntries(CONFIG_FILE_NAMES.map((name) => [
    `config/${name}.json`,
    configFilePath(root, name),
  ]));
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function readConfigFile(root: string, name: string): { value: unknown; masked: unknown; mtimeMs: number; sha256: string } | null {
  const path = configFilePath(root, name);
  if (!existsSync(path)) return null;
  const content = readFileSync(path);
  const mtimeMs = statSync(path).mtimeMs;
  try {
    const value = JSON.parse(content.toString('utf8')) as unknown;
    return { value, masked: maskJsonSecrets(value), mtimeMs, sha256: sha256(content) };
  } catch {
    return { value: null, masked: null, mtimeMs, sha256: sha256(content) };
  }
}

function readConfigFiles(root: string): Record<string, { value: unknown; masked: unknown; mtimeMs: number; sha256: string } | null> {
  return Object.fromEntries(CONFIG_FILE_NAMES.map((name) => {
    return [name, readConfigFile(root, name)];
  }));
}

export function deriveConfigFileApplyTargets(
  name: ConfigFileName,
  value: unknown,
  configuredPlatforms: readonly string[],
): string[] {
  if (name !== 'bridge-map') return [name === 'groups' ? 'whatsapp' : name.split('-')[0] ?? 'all'];

  const configured = new Set(configuredPlatforms.filter((platform) => MESSAGING_PLATFORMS.includes(platform)));
  const instances = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { instances?: unknown }).instances
    : undefined;
  if (!Array.isArray(instances)) return [];

  const targets = new Set<string>();
  for (const instance of instances) {
    const platform = instance && typeof instance === 'object' && !Array.isArray(instance)
      ? (instance as { platform?: unknown }).platform
      : undefined;
    if (typeof platform === 'string' && configured.has(platform)) targets.add(platform);
  }
  return [...targets];
}

function validateWizardArgs(value: unknown): { args: string[] } | { error: string } {
  if (value === undefined) return { args: [] };
  if (!Array.isArray(value)) return { error: 'wizard args must be an array of strings' };
  const args: string[] = [];
  for (const [index, arg] of value.entries()) {
    if (typeof arg !== 'string') return { error: `wizard arg at index ${index} must be a string` };
    const match = /^(--[a-z0-9-]+)(?:=(.*))?$/.exec(arg);
    const flag = match?.[1];
    if (!flag || !WIZARD_ARG_ALLOWLIST.has(flag)) {
      return { error: `wizard arg not allowed: ${flag ?? arg}` };
    }
    if (match[2]?.startsWith('-')) {
      return { error: `wizard arg value must not start with "-": ${flag}` };
    }
    args.push(arg);
  }
  return { args };
}

function issueResponse(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

function mergeJsonUpdate(existing: unknown, update: unknown): unknown {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return update;
  const base = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(update)) {
    if (value === null) delete result[key];
    else result[key] = mergeJsonUpdate(base[key], value);
  }
  return result;
}

function snapshotFieldMatches(expected: unknown, current: Record<string, number | string | null>): boolean {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  return Object.entries(current).every(([name, mtime]) => (expected as Record<string, unknown>)[name] === mtime);
}

function discoveredPlatforms(root: string): string[] {
  const basePath = resolve(root, '.env');
  const base = existsSync(basePath) ? parseDotenv(readFileSync(basePath, 'utf8')) : {};
  const platforms = new Set<string>();
  if (base.MESSAGING_PLATFORM) platforms.add(base.MESSAGING_PLATFORM.toLowerCase());
  for (const platform of MESSAGING_PLATFORMS) {
    if (existsSync(resolve(root, `.env.${platform}`))) platforms.add(platform);
  }
  if (platforms.size === 0) platforms.add(base.MESSAGING_PLATFORM?.toLowerCase() || 'discord');
  return [...platforms];
}

function validateEnvRoot(root: string, source: string): unknown[] {
  const issues: unknown[] = [];
  for (const platform of discoveredPlatforms(root)) {
    if (!MESSAGING_PLATFORMS.includes(platform)) {
      issues.push({ platform, path: ['MESSAGING_PLATFORM'], message: `Unsupported messaging platform: ${platform}` });
      continue;
    }
    const layered = applyEnvLayers({ baseDir: root, env: {}, realEnv: {}, platform }).env;
    layered.MESSAGING_PLATFORM = platform;
    const parsed = parseConfig(layered, { source });
    if (!parsed.ok) issues.push(...parsed.issues.map((issue) => ({ ...issue, platform })));
  }
  return issues;
}

function makeCandidateRoot(root: string): string {
  const candidateRoot = mkdtempSync(resolve(tmpdir(), 'garbanzo-config-candidate-'));
  for (const name of ENV_FILE_NAMES) {
    const source = resolve(root, name);
    if (existsSync(source)) copyFileSync(source, resolve(candidateRoot, name));
  }
  return candidateRoot;
}

function discover(root: string): JsonRecord {
  const env = readEnvSnapshot(root);
  const composeFiles = ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml']
    .filter((name) => existsSync(resolve(root, name)));
  const packageRepo = existsSync(resolve(root, 'package.json'));
  const platforms = new Set<string>();
  if (env.values.MESSAGING_PLATFORM) platforms.add(env.values.MESSAGING_PLATFORM);
  for (const name of ['discord', 'whatsapp', 'telegram', 'matrix']) {
    if (existsSync(resolve(root, `.env.${name}`))) platforms.add(name);
  }
  return {
    root,
    shape: composeFiles.length > 0 ? 'compose' : packageRepo ? 'package-repo' : 'bare',
    composeFiles,
    packageRepo,
    platform: env.values.MESSAGING_PLATFORM ?? null,
    instanceId: env.values.INSTANCE_ID ?? env.values.MESSAGING_PLATFORM ?? null,
    platforms: [...platforms],
    envFiles: Object.fromEntries(Object.entries(env.fileMtimes).map(([name, mtime]) => [name, mtime !== null])),
    configFiles: Object.fromEntries(CONFIG_FILE_NAMES.map((name) => [name, existsSync(configFilePath(root, name))])),
  };
}

function wizardField(field: Omit<SetupField, 'secret'> & { secret?: boolean }): SetupField {
  const secret = isSecretKey(field.env);
  return {
    env: field.env,
    cli: field.cli,
    default: secret ? '' : field.default,
    secret,
    ...(field.note ? { note: field.note } : {}),
  };
}

/**
 * Extracts the setup runner's own single-line failure reason (it prints
 * `❌ Setup failed: <reason>`) so the wizard can show WHY a run failed instead
 * of an empty error. Only the matched reason line is returned — never raw
 * stdout/stderr — and it is length-capped defensively.
 */
function extractSetupFailure(result: { stdout: string; stderr: string }): string | undefined {
  const combined = `${result.stdout}\n${result.stderr}`;
  const match = combined.match(/Setup failed:\s*(.+)/);
  const reason = match?.[1]?.trim();
  if (!reason) return undefined;
  return reason.length > 300 ? `${reason.slice(0, 297)}…` : reason;
}

function wizardSchema(): JsonRecord {
  // Only platforms with a field group below are offered: the wizard configures
  // real instances, and slack is a demo-only platform with no config group, so
  // offering it would hand the operator an unconfigurable instance.
  const configurablePlatforms = ['whatsapp', 'discord', 'telegram', 'matrix'];
  return {
    platforms: MESSAGING_PLATFORMS.filter((platform) => configurablePlatforms.includes(platform)),
    defaultPlatform: DEFAULT_MESSAGING_PLATFORM,
    deployTargets: ['docker', 'native'],
    providers: [...AI_PROVIDER_ORDER_VALUES],
    vectorStores: ['qdrant', 'none'],
    openaiAuthModes: [...OPENAI_AUTH_MODES],
    whatsappLoginModes: [...WHATSAPP_LOGIN_MODES],
    chatScopes: ['all', 'configured'],
    groups: {
      shared: SHARED_FIELDS.map(wizardField),
      whatsapp: WHATSAPP_FIELDS.map(wizardField),
      discord: DISCORD_FIELDS.map(wizardField),
      telegram: TELEGRAM_FIELDS.map(wizardField),
      matrix: MATRIX_FIELDS.map(wizardField),
    },
  };
}

function validateCandidates(root: string, payload: JsonRecord): Array<unknown> {
  const candidateRoot = makeCandidateRoot(root);
  const issues: unknown[] = [];
  try {
    if (payload.env && typeof payload.env === 'object' && !Array.isArray(payload.env)) {
      const snapshot = readEnvSnapshot(candidateRoot);
      writeEnvUpdate(candidateRoot, payload.env as Record<string, string | null>, snapshot);
    }
    issues.push(...validateEnvRoot(candidateRoot, 'config-service'));
  } finally {
    rmSync(candidateRoot, { recursive: true, force: true });
  }
  if (payload.files && typeof payload.files === 'object' && !Array.isArray(payload.files)) {
    for (const [name, value] of Object.entries(payload.files as Record<string, unknown>)) {
      if (!isConfigFileName(name)) continue;
      issues.push(...zodIssues(validateConfigFile(name, value)).map((issue) => ({ ...issue, file: name })));
    }
  }
  return issues;
}

function validateImportBundle(root: string, bundle: ConfigBundle): unknown[] {
  const issues: unknown[] = [];
  const deadline = Date.now() + IMPORT_LIMITS.timeoutMs;
  for (const [path, content] of Object.entries(bundle.files)) {
    if (Date.now() > deadline) throw new Error('import-timeout');
    const match = path.match(/^config\/([^/]+)\.json$/);
    if (!match) continue;
    const name = match[1] ?? '';
    if (!isConfigFileName(name)) continue;
    try {
      const target = configFilePath(root, name);
      const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) as unknown : undefined;
      const candidate = restoreJsonPlaceholders(existing, JSON.parse(content) as unknown);
      issues.push(...zodIssues(validateConfigFile(name, candidate)).map((issue) => ({ ...issue, file: path })));
    } catch (error) {
      issues.push({ file: path, message: error instanceof SyntaxError ? 'invalid JSON' : issueResponse(error).error });
    }
  }

  const candidateRoot = makeCandidateRoot(root);
  try {
    for (const [path, content] of Object.entries(bundle.files)) {
      if (!/^\.env(?:\.|$)/.test(path)) continue;
      const destination = resolve(candidateRoot, path);
      const existing = existsSync(destination) ? readFileSync(destination, 'utf8') : '';
      const imported = envWithoutRedactedPlaceholders(content);
      writeFileWithBackupAtomic(destination, mergeEnvFileContent(existing, imported), { backup: false });
    }
    issues.push(...validateEnvRoot(candidateRoot, 'config-service-import'));
  } finally {
    rmSync(candidateRoot, { recursive: true, force: true });
  }
  return issues;
}

async function dockerComposeAvailable(root: string): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const child = spawn('docker', ['compose', 'version'], { cwd: root, stdio: 'ignore' });
    child.on('error', () => resolveCheck(false));
    child.on('close', (code) => resolveCheck(code === 0));
  });
}

export async function startConfigService(options: ConfigServiceOptions): Promise<ConfigServiceHandle> {
  const root = resolve(options.root);
  const spa = createSpaAssets(options.webDist);
  pruneStaleStaging(root);
  const entryToken = randomBytes(32).toString('base64url');
  let sessionToken: string | null = null;
  let entryUsed = false;
  let applied = false;
  const changedTargets = new Set<string>();
  const staging = new Map<string, { dir: string; preconditions: BundlePreconditions }>();
  let idleTimer: NodeJS.Timeout;
  // Auto-exit is a security control (limits the window an issued entry/session
  // token stays live), so only *authenticated* activity may extend it. If the
  // unauthenticated shell/asset routes or rejected requests reset it, any
  // localhost process could pin the service open indefinitely without a token.
  const refreshIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => server.close(), options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
  };
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolvePromise) => { resolveClosed = resolvePromise; });

  const server = createServer(async (req, res) => {
    securityHeaders(res);
    if (!hostAllowed(req.headers.host)) {
      json(res, 403, { error: 'host-not-allowed' });
      return;
    }
    if (!originAllowed(typeof req.headers.origin === 'string' ? req.headers.origin : undefined)) {
      json(res, 403, { error: 'origin-not-allowed' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      const asset = spa.index();
      res.setHeader('Content-Type', asset.contentType);
      res.end(asset.body);
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const asset = spa.asset(url.pathname);
      if (!asset) {
        json(res, 404, { error: 'asset-not-found' });
        return;
      }
      res.setHeader('Content-Type', asset.contentType);
      res.end(asset.body);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico')) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(FAVICON_SVG);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/session') {
      const supplied = bearer(req);
      if (entryUsed || !supplied || !safeEqual(entryToken, supplied)) {
        json(res, 401, { error: 'invalid-session-entry' });
        return;
      }
      entryUsed = true;
      sessionToken = randomBytes(32).toString('base64url');
      refreshIdle();
      json(res, 200, { token: sessionToken });
      return;
    }

    const supplied = bearer(req);
    if (applied || !sessionToken || !supplied || !safeEqual(sessionToken, supplied)) {
      json(res, 401, { error: 'bearer-required' });
      return;
    }
    refreshIdle();

    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        json(res, 200, discover(root));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/wizard/schema') {
        json(res, 200, wizardSchema());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        const env = readEnvSnapshot(root);
        const files = readConfigFiles(root);
        json(res, 200, {
          env: env.masked,
          mtimeMs: env.mtimeMs,
          fileMtimes: env.fileMtimes,
          fileHashes: env.fileHashes,
          files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file && {
            value: file.masked,
            mtimeMs: file.mtimeMs,
            sha256: file.sha256,
          }])),
        });
        return;
      }
      if (req.method === 'PUT' && url.pathname === '/api/config') {
        const { value: payload } = await readJson(req);
        const current = readEnvSnapshot(root);
        if (payload.mtimeMs !== current.mtimeMs
          || !snapshotFieldMatches(payload.fileMtimes, current.fileMtimes)
          || !snapshotFieldMatches(payload.fileHashes, current.fileHashes)) {
          json(res, 409, { reason: 'changed-on-disk' });
          return;
        }
        const update = payload.update;
        if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('update object required');
        const normalized: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(update as Record<string, unknown>)) {
          if (value !== null && typeof value !== 'string') throw new Error(`string or null required for ${key}`);
          if (value === '' && isSecretKey(key)) continue;
          normalized[key] = value;
        }
        const candidateRoot = makeCandidateRoot(root);
        writeEnvUpdate(candidateRoot, normalized, readEnvSnapshot(candidateRoot));
        const candidateIssues = validateEnvRoot(candidateRoot, 'config-service');
        const candidate = readEnvSnapshot(candidateRoot).values;
        rmSync(candidateRoot, { recursive: true, force: true });
        if (candidateIssues.length > 0) {
          json(res, 422, { issues: candidateIssues });
          return;
        }
        writeEnvUpdate(root, normalized, current);
        writeRecoveryNote(root, ['.env and platform env files']);
        appendConfigAudit(root, {
          action: 'config-update', target: 'env', sourceIp: req.socket.remoteAddress,
          changes: Object.entries(normalized).map(([key, after]) => ({ key, before: current.values[key], after })),
        });
        for (const platform of discover(root).platforms as string[]) changedTargets.add(platform);
        changedTargets.add(current.values.MESSAGING_PLATFORM ?? 'all');
        changedTargets.add(candidate.MESSAGING_PLATFORM ?? 'all');
        json(res, 200, { ok: true, mtimeMs: readEnvSnapshot(root).mtimeMs });
        return;
      }

      const fileMatch = url.pathname.match(/^\/api\/config-file\/([^/]+)$/);
      if (req.method === 'GET' && fileMatch) {
        const name = decodeURIComponent(fileMatch[1] ?? '');
        if (!isConfigFileName(name)) {
          json(res, 404, { error: 'unknown-config-file' });
          return;
        }
        const file = readConfigFile(root, name);
        json(res, 200, file
          ? { value: file.masked, mtimeMs: file.mtimeMs, sha256: file.sha256 }
          : { value: null, mtimeMs: 0, sha256: null });
        return;
      }
      if (req.method === 'PUT' && fileMatch) {
        const name = decodeURIComponent(fileMatch[1] ?? '');
        if (!isConfigFileName(name)) {
          json(res, 404, { error: 'unknown-config-file' });
          return;
        }
        const { value: payload } = await readJson(req);
        const path = configFilePath(root, name);
        const currentContent = existsSync(path) ? readFileSync(path) : null;
        const currentMtime = currentContent ? statSync(path).mtimeMs : 0;
        const currentSha256 = currentContent ? sha256(currentContent) : null;
        if (payload.mtimeMs !== currentMtime
          || (payload.sha256 !== undefined && payload.sha256 !== currentSha256)) {
          json(res, 409, { reason: 'changed-on-disk' });
          return;
        }
        const existingValue = currentContent ? JSON.parse(currentContent.toString('utf8')) as unknown : {};
        // The editor loads the masked read-back; on a full-document PUT secret
        // placeholders must be restored to their real on-disk values before
        // validate/write, or the masked document fails schema validation and
        // the save is rejected.
        // Mirrors the import path, which restores placeholders the same way.
        const resultingValue = payload.update !== undefined
          ? mergeJsonUpdate(existingValue, payload.update)
          : payload.value === undefined
            ? undefined
            : restoreJsonPlaceholders(existingValue, payload.value);
        if (resultingValue === undefined) throw new Error('value or update required');
        const issues = validateConfigFile(name, resultingValue);
        if (issues.length > 0) {
          json(res, 422, { issues: zodIssues(issues) });
          return;
        }
        const before = existsSync(path) ? maskJsonSecrets(existingValue) : null;
        writeJsonWithBackupAtomic(path, resultingValue);
        writeRecoveryNote(root, [`config/${name}.json`]);
        appendConfigAudit(root, {
          action: 'config-file-update', target: `config/${name}.json`, sourceIp: req.socket.remoteAddress,
          changes: [{ key: name, before, after: maskJsonSecrets(resultingValue) }],
        });
        for (const target of deriveConfigFileApplyTargets(name, resultingValue, discover(root).platforms as string[])) {
          changedTargets.add(target);
        }
        const written = readFileSync(path);
        json(res, 200, { ok: true, mtimeMs: statSync(path).mtimeMs, sha256: sha256(written) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/validate') {
        const { value: payload } = await readJson(req);
        const issues = validateCandidates(root, payload);
        json(res, issues.length > 0 ? 422 : 200, { ok: issues.length === 0, issues });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        json(res, 200, buildExportBundle(root, effectiveConfigPaths(root)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/import') {
        const contentType = String(req.headers['content-type'] ?? '');
        const body = await readBody(req);
        const raw: ConfigBundle & { stagingId?: string; confirm?: boolean } = contentType.startsWith('multipart/form-data')
          ? parseMultipartBundle(contentType, body)
          : JSON.parse(body.toString('utf8')) as ConfigBundle & { stagingId?: string; confirm?: boolean };
        if ('confirm' in raw && raw.confirm && raw.stagingId) {
          const pending = staging.get(raw.stagingId);
          if (!pending) {
            json(res, 404, { error: 'staging-id-not-found' });
            return;
          }
          const configPaths = effectiveConfigPaths(root);
          if (!bundlePreconditionsMatch(root, pending.preconditions, configPaths)) {
            json(res, 409, { reason: 'changed-on-disk' });
            return;
          }
          const stagedBundle = readStagedBundle(pending.dir);
          const confirmIssues = validateImportBundle(root, stagedBundle);
          if (confirmIssues.length > 0) {
            json(res, 422, { issues: confirmIssues });
            return;
          }
          const changed = applyStagedBundle(root, pending.dir, (path) => configPaths[path]);
          writeRecoveryNote(root, changed);
          rmSync(pending.dir, { recursive: true, force: true });
          staging.delete(raw.stagingId);
          appendConfigAudit(root, {
            action: 'import-apply', target: 'config-root', sourceIp: req.socket.remoteAddress,
            changes: changed.map((key) => ({ key, after: 'changed' })),
          });
          changed.forEach((path) => changedTargets.add(path));
          json(res, 200, { ok: true, changed });
          return;
        }
        if (raw.format !== undefined && raw.format !== 'garbanzo-config-bundle-v1') throw new Error('unsupported-bundle-format');
        const bundle: ConfigBundle = { format: 'garbanzo-config-bundle-v1', files: raw.files ?? {} };
        const limitError = validateBundleLimits(bundle, Math.max(1, body.length));
        if (limitError) {
          json(res, 422, { error: limitError });
          return;
        }
        const validationIssues = validateImportBundle(root, bundle);
        if (validationIssues.length > 0) {
          json(res, 422, { issues: validationIssues });
          return;
        }
        const staged = stageBundle(root, bundle);
        staging.set(staged.id, {
          dir: staged.dir,
          preconditions: captureBundlePreconditions(root, bundle, effectiveConfigPaths(root)),
        });
        json(res, 200, { stagingId: staged.id, diff: buildExportBundle(staged.dir).files });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/wizard') {
        const { value: payload } = await readJson(req);
        const wizardArgs = validateWizardArgs(payload.args);
        if ('error' in wizardArgs) {
          json(res, 422, { error: wizardArgs.error });
          return;
        }
        const wizardState = discover(root);
        if (Object.values(wizardState.envFiles as Record<string, boolean>).some(Boolean)
          || Object.values(wizardState.configFiles as Record<string, boolean>).some(Boolean)) {
          json(res, 409, { error: 'wizard requires an empty config root' });
          return;
        }
        const wizardRoot = mkdtempSync(resolve(tmpdir(), 'garbanzo-config-wizard-'));
        const result = await runWizard(wizardRoot, {
          fields: payload.fields as Record<string, unknown> | undefined,
          args: wizardArgs.args,
        });
        const wizardValidation = result.code === 0
          ? parseConfig(readEnvSnapshot(wizardRoot).values, { source: 'config-service-wizard' })
          : null;
        if (result.code !== 0 || !wizardValidation?.ok) {
          rmSync(wizardRoot, { recursive: true, force: true });
          // When the setup runner itself exits non-zero (missing required field,
          // bad channel id, unknown persona) there are no structured parseConfig
          // issues, so surface its own "Setup failed:" reason — otherwise the
          // wizard shows an empty, unactionable error. Only the controlled
          // single-line reason is echoed (never raw stderr), and these messages
          // are validation text about the operator's own inputs, not secrets.
          const issues = wizardValidation && !wizardValidation.ok ? wizardValidation.issues : [];
          const message = issues.length === 0 ? extractSetupFailure(result) : undefined;
          json(res, 422, { error: 'wizard-validation-failed', issues, ...(message ? { message } : {}) });
          return;
        }
        const written = applyStagedBundle(root, wizardRoot);
        writeRecoveryNote(root, written);
        rmSync(wizardRoot, { recursive: true, force: true });
        appendConfigAudit(root, { action: 'wizard', target: 'first-run', sourceIp: req.socket.remoteAddress, changes: [{ key: 'wizard', after: 'changed' }] });
        changedTargets.add(readEnvSnapshot(root).values.MESSAGING_PLATFORM ?? 'all');
        json(res, 200, { ok: true, written });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/apply') {
        const state = discover(root);
        const env = readEnvSnapshot(root).values;
        const compose = state.shape === 'compose' && await dockerComposeAvailable(root);
        if (compose) {
          const services = [...changedTargets].filter((name) => MESSAGING_PLATFORMS.includes(name));
          const fallbackServices = [...(state.platforms as string[])];
          if (fallbackServices.some((name) => !MESSAGING_PLATFORMS.includes(name))) {
            json(res, 422, { error: 'unsupported messaging platform discovered; refusing compose apply' });
            return;
          }
          const args = ['compose', 'up', '-d', ...(services.length > 0 ? services : fallbackServices)];
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.write(`$ docker ${args.join(' ')}\n`);
          const child = spawn('docker', args, { cwd: root });
          child.stdout.pipe(res, { end: false });
          child.stderr.pipe(res, { end: false });
          child.on('close', (code) => {
            res.end(`\nexit ${code ?? 1}\n`);
            if (code === 0) {
              appendConfigAudit(root, { action: 'apply', target: 'compose', sourceIp: req.socket.remoteAddress, changes: [...changedTargets].map((key) => ({ key, after: 'applied' })) });
              applied = true;
              sessionToken = null;
              setImmediate(() => server.close());
            }
          });
          return;
        }
        const command = existsSync(resolve(root, 'package.json')) ? 'npm run start' : 'garbanzo start';
        const guidance = env.GARBANZO_SUPERVISED === 'true' || env.GARBANZO_SUPERVISED === '1'
          ? `Restart the supervised Garbanzo service, then verify its health endpoint.`
          : `Run: cd ${JSON.stringify(root)} && ${command}`;
        appendConfigAudit(root, { action: 'apply', target: String(state.shape), sourceIp: req.socket.remoteAddress, changes: [...changedTargets].map((key) => ({ key, after: 'applied' })) });
        applied = true;
        sessionToken = null;
        json(res, 200, { ok: true, mode: state.shape, guidance });
        setImmediate(() => server.close());
        return;
      }
      json(res, 404, { error: 'not-found' });
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : error instanceof Error && error.message.includes('limit') ? 413 : 400;
      json(res, status, issueResponse(error));
    }
  });

  server.on('close', () => {
    clearTimeout(idleTimer);
    for (const pending of staging.values()) rmSync(pending.dir, { recursive: true, force: true });
    staging.clear();
    resolveClosed();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('config service failed to bind');
  const port = address.port;
  refreshIdle();
  const print = options.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  print(`One-time token: ${entryToken}`);
  print(`Open: http://127.0.0.1:${port}/`);
  print(`Remote tunnel: ssh -L ${port}:127.0.0.1:${port} <user>@<host>`);

  return {
    port,
    root,
    entryToken,
    closed,
    close: async () => {
      if (!server.listening) return closed;
      server.close();
      return closed;
    },
  };
}

export function parseConfigServiceArgs(args: string[]): { root: string; port: number } {
  let root = process.env.GARBANZO_HOME?.trim() || process.cwd();
  let portText = process.env.ADMIN_CONFIG_PORT?.trim() ?? '0';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--root') root = args[++index] ?? '';
    else if (arg.startsWith('--root=')) root = arg.slice('--root='.length);
    else if (arg === '--port') portText = args[++index] ?? '';
    else if (arg.startsWith('--port=')) portText = arg.slice('--port='.length);
    else throw new Error(`Unknown config option: ${arg}`);
  }
  const port = Number(portText);
  if (!root || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('config --port must be 0-65535 and --root must be non-empty');
  return { root, port };
}

export async function runConfigService(args: string[]): Promise<number> {
  const options = parseConfigServiceArgs(args);
  const service = await startConfigService(options);
  await service.closed;
  return 0;
}
