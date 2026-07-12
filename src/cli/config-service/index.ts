import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

import { parse as parseDotenv } from 'dotenv';

import { parseConfig } from '../../utils/config/parse-config.js';
import { applyEnvLayers } from '../../utils/config/shared.js';
import { mergeEnvFileContent, MESSAGING_PLATFORMS } from '../../config-core/fields.js';
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
} from './json-config.js';
import { CSP, SHELL_CSS, SHELL_HTML, SHELL_JS } from './shell.js';
import { runWizard } from './wizard.js';

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const BODY_LIMIT = IMPORT_LIMITS.compressedBytes;

export interface ConfigServiceOptions {
  root: string;
  port?: number;
  idleTtlMs?: number;
  print?: (message: string) => void;
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

function readConfigFiles(root: string): Record<string, { value: unknown; masked: unknown; mtimeMs: number } | null> {
  return Object.fromEntries(CONFIG_FILE_NAMES.map((name) => {
    const path = configFilePath(root, name);
    if (!existsSync(path)) return [name, null];
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return [name, { value, masked: maskJsonSecrets(value), mtimeMs: statSync(path).mtimeMs }];
    } catch {
      return [name, { value: null, masked: null, mtimeMs: statSync(path).mtimeMs }];
    }
  }));
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
    platforms: [...platforms],
    envFiles: Object.fromEntries(Object.entries(env.fileMtimes).map(([name, mtime]) => [name, mtime !== null])),
    configFiles: Object.fromEntries(CONFIG_FILE_NAMES.map((name) => [name, existsSync(configFilePath(root, name))])),
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
      if (!isConfigFileName(name) || name === 'bridge-map') continue;
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
    if (name === 'bridge-map') {
      issues.push({ file: path, message: 'bridge-map is read-only in v3.4.0 and omitted from v1 exports' });
      continue;
    }
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
  pruneStaleStaging(root);
  const entryToken = randomBytes(32).toString('base64url');
  let sessionToken: string | null = null;
  let entryUsed = false;
  let applied = false;
  const changedTargets = new Set<string>();
  const staging = new Map<string, { dir: string; preconditions: BundlePreconditions }>();
  let idleTimer: NodeJS.Timeout;
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
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => server.close(), options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(SHELL_HTML);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/shell.css') {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.end(SHELL_CSS);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/shell.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(SHELL_JS);
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
      json(res, 200, { token: sessionToken });
      return;
    }

    const supplied = bearer(req);
    if (applied || !sessionToken || !supplied || !safeEqual(sessionToken, supplied)) {
      json(res, 401, { error: 'bearer-required' });
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        json(res, 200, discover(root));
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
      if (req.method === 'PUT' && fileMatch) {
        const name = decodeURIComponent(fileMatch[1] ?? '');
        if (!isConfigFileName(name)) {
          json(res, 404, { error: 'unknown-config-file' });
          return;
        }
        if (name === 'bridge-map') {
          json(res, 422, { error: 'bridge-map is read-only in v3.4.0; editing is deferred' });
          return;
        }
        const { value: payload } = await readJson(req);
        const path = configFilePath(root, name);
        const currentMtime = existsSync(path) ? statSync(path).mtimeMs : 0;
        if (payload.mtimeMs !== currentMtime) {
          json(res, 409, { reason: 'changed-on-disk' });
          return;
        }
        const existingValue = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as unknown : {};
        const resultingValue = payload.update !== undefined
          ? mergeJsonUpdate(existingValue, payload.update)
          : payload.value;
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
        changedTargets.add(name === 'groups' ? 'whatsapp' : name.split('-')[0] ?? 'all');
        json(res, 200, { ok: true, mtimeMs: statSync(path).mtimeMs });
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
        const wizardState = discover(root);
        if (Object.values(wizardState.envFiles as Record<string, boolean>).some(Boolean)
          || Object.values(wizardState.configFiles as Record<string, boolean>).some(Boolean)) {
          json(res, 409, { error: 'wizard requires an empty config root' });
          return;
        }
        const wizardRoot = mkdtempSync(resolve(tmpdir(), 'garbanzo-config-wizard-'));
        const result = await runWizard(wizardRoot, payload as { fields?: Record<string, unknown>; args?: string[] });
        const wizardValidation = result.code === 0
          ? parseConfig(readEnvSnapshot(wizardRoot).values, { source: 'config-service-wizard' })
          : null;
        if (result.code !== 0 || !wizardValidation?.ok) {
          rmSync(wizardRoot, { recursive: true, force: true });
          json(res, 422, {
            error: 'wizard-validation-failed',
            issues: wizardValidation && !wizardValidation.ok ? wizardValidation.issues : [],
          });
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
  idleTimer = setTimeout(() => server.close(), options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
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
