import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type AtomicWriteOptions = {
  backup?: boolean;
  /** Explicit permission bits for the written file, overriding the default policy. */
  mode?: number;
};

/** Owner-only; used for credential files and every backup copy. */
const SECRET_MODE = 0o600;
/**
 * Group/other readable. config/*.json are bind-mounted read-only into the
 * container and read by the `garbanzo` uid, which usually differs from the
 * host operator's uid, so they must stay world-readable.
 */
const CONFIG_MODE = 0o644;

/**
 * `.env` and `.env.<platform>` hold API keys, bot tokens, and the
 * monitoring/admin tokens. They are read by the operator (native) or the
 * Docker daemon (env_file) — never by the container's own uid — so lock them
 * to owner-only, always, even when an existing file was created world-readable.
 */
function isCredentialFile(path: string): boolean {
  const name = path.split(/[\\/]/).at(-1) ?? '';
  return /^\.env(?:\.|$)/.test(name);
}

function resolveWriteMode(path: string, fileExists: boolean, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  if (isCredentialFile(path)) return SECRET_MODE;
  return fileExists ? statSync(path).mode & 0o777 : CONFIG_MODE;
}

/**
 * Replaces one file atomically within its directory. Existing files are
 * copied to the stable `.bak` path immediately before the replacement.
 */
export function writeFileWithBackupAtomic(
  path: string,
  content: string,
  options: AtomicWriteOptions = {},
): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });

  const shouldBackup = options.backup ?? true;
  const fileExists = existsSync(path);
  const mode = resolveWriteMode(path, fileExists, options.mode);
  if (shouldBackup && fileExists) {
    const backupPath = `${path}.bak`;
    copyFileSync(path, backupPath);
    // A backup of a credential file must never be world-readable regardless of
    // the original's mode; harmless (never container-read) for other files.
    chmodSync(backupPath, SECRET_MODE);
  }

  const tempPath = join(
    parent,
    `.${path.split(/[\\/]/).at(-1) ?? 'garbanzo'}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );

  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', mode });
    chmodSync(tempPath, mode);
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function writeJsonWithBackupAtomic(path: string, value: unknown): void {
  writeFileWithBackupAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
