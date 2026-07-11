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
};

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
  const mode = fileExists ? statSync(path).mode & 0o777 : 0o666;
  if (shouldBackup && fileExists) {
    copyFileSync(path, `${path}.bak`);
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
