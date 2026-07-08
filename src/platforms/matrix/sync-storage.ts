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
 * The SDK's SimpleFsStorageProvider throws on corrupt JSON instead of
 * starting fresh, so the corrupt-file guard must run BEFORE handing it the
 * path: a broken store is moved aside (kept for inspection) and the sync
 * starts fresh with a warning — same recovery the fallback provider gives.
 */
function quarantineCorruptSyncFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const quarantined = `${path}.corrupt`;
    logger.warn({ err, path, quarantined }, 'Matrix sync store is corrupt; moving it aside and starting a fresh sync');
    renameSync(path, quarantined);
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
