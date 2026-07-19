import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import { redactEnvContent } from '../../config-core/secret-classifier.js';
import { mergeEnvFileContent } from '../../config-core/fields.js';
import { writeFileWithBackupAtomic } from '../../config-core/writers.js';
import { maskJsonSecrets } from './json-config.js';

export const IMPORT_LIMITS = {
  compressedBytes: 10 * 1024 * 1024,
  expandedBytes: 50 * 1024 * 1024,
  files: 200,
  depth: 5,
  ratio: 100,
  timeoutMs: 30_000,
} as const;

export type ConfigBundle = { format: 'garbanzo-config-bundle-v1'; files: Record<string, string> };
export type TargetPrecondition = { exists: boolean; mtimeMs: number | null; sha256: string | null };
export type BundlePreconditions = Record<string, TargetPrecondition>;

const OMIT_PARTS = new Set(['.git', 'node_modules', 'dist', 'data']);

function recognized(path: string): boolean {
  return /^\.env(?:\.[a-z0-9_-]+)?$/i.test(path)
    || /^config\/(?:groups|discord-channels|telegram-chats|matrix-rooms|rag-sources|bridge-map)\.json$/.test(path)
    || /^docs\/(?:PERSONA\.md|personas\/[^/]+\.md)$/.test(path);
}

function walk(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (OMIT_PARTS.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = resolve(current, entry.name);
    const rel = relative(root, path).split(sep).join('/');
    if (entry.isDirectory()) files.push(...walk(root, path));
    else if (entry.isFile() && recognized(rel)) files.push(rel);
  }
  return files;
}

function redactFile(path: string, content: string): string {
  if (/^\.env(?:\.|$)/.test(path)) return redactEnvContent(content);
  if (path.startsWith('config/') && path.endsWith('.json')) {
    try {
      // Bridge-map topology and placeholder URLs are public config, so they
      // export unchanged. The shared masker still redacts any URL that embeds
      // credentials or sensitive query parameters.
      return `${JSON.stringify(maskJsonSecrets(JSON.parse(content) as unknown), null, 2)}\n`;
    } catch {
      return `${JSON.stringify({ __redacted_unparseable__: true }, null, 2)}\n`;
    }
  }
  return content;
}

export function buildExportBundle(root: string, sourceOverrides: Record<string, string> = {}): ConfigBundle {
  const paths = new Set(walk(root));
  for (const [logicalPath, source] of Object.entries(sourceOverrides)) {
    if (existsSync(source)) paths.add(logicalPath);
  }
  const files = Object.fromEntries([...paths].map((path) => {
    const content = readFileSync(sourceOverrides[path] ?? resolve(root, path), 'utf8');
    return [path, redactFile(path, content)];
  }));
  return { format: 'garbanzo-config-bundle-v1', files };
}

export function safeBundlePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.replace(/\\/g, '/').split('/');
  return parts.length <= IMPORT_LIMITS.depth && parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

export function validateBundleLimits(bundle: ConfigBundle, compressedBytes: number): string | null {
  const entries = Object.entries(bundle.files);
  if (compressedBytes > IMPORT_LIMITS.compressedBytes) return 'compressed-size-limit';
  if (entries.length > IMPORT_LIMITS.files) return 'file-count-limit';
  let expanded = 0;
  for (const [path, content] of entries) {
    if (!safeBundlePath(path)) return 'unsafe-path';
    if (typeof content !== 'string') return 'invalid-content';
    expanded += Buffer.byteLength(content);
  }
  if (expanded > IMPORT_LIMITS.expandedBytes) return 'expanded-size-limit';
  if (expanded > Math.max(1, compressedBytes) * IMPORT_LIMITS.ratio) return 'expansion-ratio-limit';
  return null;
}

export function stageBundle(root: string, bundle: ConfigBundle): { id: string; dir: string } {
  const id = randomBytes(16).toString('hex');
  const dir = resolve(root, 'data', 'config-import-staging', id);
  for (const [path, content] of Object.entries(bundle.files)) {
    if (!recognized(path)) continue;
    const destination = resolve(dir, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileWithBackupAtomic(destination, content, { backup: false });
  }
  return { id, dir };
}

export function readStagedBundle(dir: string): ConfigBundle {
  if (!existsSync(dir)) throw new Error('staging id not found');
  return {
    format: 'garbanzo-config-bundle-v1',
    files: Object.fromEntries(walk(dir).map((path) => [path, readFileSync(resolve(dir, path), 'utf8')])),
  };
}

function targetPrecondition(path: string): TargetPrecondition {
  if (!existsSync(path)) return { exists: false, mtimeMs: null, sha256: null };
  const content = readFileSync(path);
  return {
    exists: true,
    mtimeMs: statSync(path).mtimeMs,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

export function captureBundlePreconditions(
  root: string,
  bundle: ConfigBundle,
  targetOverrides: Record<string, string> = {},
): BundlePreconditions {
  return Object.fromEntries(Object.keys(bundle.files).filter(recognized).map((path) => [
    path,
    targetPrecondition(targetOverrides[path] ?? resolve(root, path)),
  ]));
}

export function bundlePreconditionsMatch(
  root: string,
  expected: BundlePreconditions,
  targetOverrides: Record<string, string> = {},
): boolean {
  return Object.entries(expected).every(([path, precondition]) => {
    const current = targetPrecondition(targetOverrides[path] ?? resolve(root, path));
    return current.exists === precondition.exists
      && current.mtimeMs === precondition.mtimeMs
      && current.sha256 === precondition.sha256;
  });
}

export function stagingRoot(root: string): string {
  return resolve(root, 'data', 'config-import-staging');
}

export function pruneStaleStaging(root: string, maxAgeMs = 24 * 60 * 60 * 1000): void {
  const parent = stagingRoot(root);
  if (!existsSync(parent)) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(parent, entry.name);
    if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
  }
}

export function envWithoutRedactedPlaceholders(content: string): string {
  return content.split(/(?<=\n)/).filter((line) => !/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*\[REDACTED\]/.test(line)).join('');
}

function isSetPlaceholder(value: unknown): value is { set: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 1 && entries[0]?.[0] === 'set' && typeof entries[0][1] === 'boolean';
}

export function restoreJsonPlaceholders(existing: unknown, candidate: unknown): unknown {
  if (isSetPlaceholder(candidate)) {
    if (existing === undefined) throw new Error('secret placeholder identity changed or no longer exists');
    return existing;
  }
  if (Array.isArray(candidate)) {
    const existingItems = Array.isArray(existing) ? existing : [];
    return candidate.map((item, index) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const identity = ['id', 'jid', 'chatId', 'instance'].find((key) => typeof (item as Record<string, unknown>)[key] === 'string');
        if (identity) {
          const identityValue = (item as Record<string, unknown>)[identity];
          const matching = existingItems.find((existingItem) => existingItem && typeof existingItem === 'object'
            && !Array.isArray(existingItem) && (existingItem as Record<string, unknown>)[identity] === identityValue);
          return restoreJsonPlaceholders(matching, item);
        }
      }
      return restoreJsonPlaceholders(existingItems[index], item);
    });
  }
  if (candidate && typeof candidate === 'object') {
    const existingRecord = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {};
    return Object.fromEntries(Object.entries(candidate).flatMap(([key, value]) => {
      const restored = restoreJsonPlaceholders(existingRecord[key], value);
      return restored === undefined ? [] : [[key, restored]];
    }));
  }
  return candidate;
}

export function applyStagedBundle(
  root: string,
  stagingDir: string,
  targetOverride: (logicalPath: string) => string | undefined = () => undefined,
): string[] {
  if (!existsSync(stagingDir)) throw new Error('staging id not found');
  const changed: string[] = [];
  for (const path of walk(stagingDir)) {
    const source = resolve(stagingDir, path);
    if (!statSync(source).isFile()) continue;
    const destination = targetOverride(path) ?? resolve(root, path);
    const stagedContent = readFileSync(source, 'utf8');
    if (/^\.env(?:\.|$)/.test(path)) {
      const existing = existsSync(destination) ? readFileSync(destination, 'utf8') : '';
      writeFileWithBackupAtomic(destination, mergeEnvFileContent(existing, envWithoutRedactedPlaceholders(stagedContent)));
    } else if (path.startsWith('config/') && path.endsWith('.json')) {
      const existing = existsSync(destination) ? JSON.parse(readFileSync(destination, 'utf8')) as unknown : undefined;
      const candidate = JSON.parse(stagedContent) as unknown;
      writeFileWithBackupAtomic(destination, `${JSON.stringify(restoreJsonPlaceholders(existing, candidate), null, 2)}\n`);
    } else {
      writeFileWithBackupAtomic(destination, stagedContent);
    }
    changed.push(path);
  }
  return changed;
}
