import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { logger } from '../../middleware/logger.js';
import { homePath } from '../../utils/paths.js';

export const MATRIX_SYNC_STORAGE_PATH = homePath('data', 'matrix-sync.json');

export interface MatrixStorageProvider {
  getSyncToken(): Promise<string | null> | string | null;
  setSyncToken(token: string | null): Promise<void> | void;
}

interface MatrixSyncFile {
  syncToken?: string | null;
}

function readSyncFile(path: string): MatrixSyncFile {
  if (!existsSync(path)) return {};

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MatrixSyncFile;
  } catch (err) {
    logger.warn({ err, path }, 'Matrix sync-token store is missing or corrupt; starting with a fresh sync');
    return {};
  }
}

function writeSyncFileAtomic(path: string, body: MatrixSyncFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
  renameSync(tmp, path);
}

/**
 * Thin fallback provider used in tests and when the SDK class is unavailable.
 * In production createMatrixStorageProvider prefers matrix-bot-sdk's
 * SimpleFsStorageProvider because it persists the SDK's full sync bookkeeping
 * (sync token, filter id, autojoin state) to this same file.
 */
export class MatrixSyncTokenStorageProvider implements MatrixStorageProvider {
  constructor(private readonly path: string = MATRIX_SYNC_STORAGE_PATH) {}

  getSyncToken(): string | null {
    return readSyncFile(this.path).syncToken ?? null;
  }

  setSyncToken(token: string | null): void {
    writeSyncFileAtomic(this.path, { syncToken: token });
  }
}

/**
 * Find a quarantine destination that won't clobber a previous quarantine:
 * `<path>.corrupt`, then `<path>.corrupt.1`, `<path>.corrupt.2`, ... — each
 * corrupt file found across restarts is kept for inspection instead of
 * silently overwriting the last one.
 */
function findQuarantinePath(path: string): string {
  const base = `${path}.corrupt`;
  if (!existsSync(base)) return base;
  let n = 1;
  while (existsSync(`${base}.${n}`)) n += 1;
  return `${base}.${n}`;
}

/**
 * The SDK's SimpleFsStorageProvider throws on corrupt JSON instead of
 * starting fresh, so the corrupt-file guard must run BEFORE handing it the
 * path: a broken store is moved aside (kept for inspection) and the sync
 * starts fresh with a warning — same recovery the fallback provider gives.
 *
 * Every filesystem call here is wrapped in try/catch: a rare IO race (the
 * file is deleted or replaced between our existsSync probe and the actual
 * read/rename, a transient permission or EBUSY error, etc.) must degrade
 * gracefully rather than throwing out of startup. If quarantining itself
 * fails, we log and leave the file in place — worst case
 * SimpleFsStorageProvider's own constructor then throws on the still-corrupt
 * file, and createMatrixStorageProvider's existing catch below falls back to
 * MatrixSyncTokenStorageProvider, so startup still completes.
 */
function quarantineCorruptSyncFile(path: string): void {
  try {
    if (!existsSync(path)) return;
    JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    try {
      const quarantined = findQuarantinePath(path);
      logger.warn({ err, path, quarantined }, 'Matrix sync store is corrupt; moving it aside and starting a fresh sync');
      renameSync(path, quarantined);
    } catch (quarantineErr) {
      logger.warn(
        { err: quarantineErr, path },
        'Matrix sync store is corrupt but quarantining it also failed (IO race?) — leaving it in place; the caller falls back to the token store if the SDK provider then fails to load it',
      );
    }
  }
}

export function createMatrixStorageProvider(
  SimpleFsStorageProvider?: new (path: string) => MatrixStorageProvider,
  path: string = MATRIX_SYNC_STORAGE_PATH,
): MatrixStorageProvider {
  if (SimpleFsStorageProvider) {
    quarantineCorruptSyncFile(path);
    try {
      return new SimpleFsStorageProvider(path);
    } catch (err) {
      logger.warn({ err, path }, 'SDK sync storage failed to initialize; using the fallback token store');
    }
  }

  return new MatrixSyncTokenStorageProvider(path);
}
