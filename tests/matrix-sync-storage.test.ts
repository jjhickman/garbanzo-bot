import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MatrixSyncTokenStorageProvider } from '../src/platforms/matrix/sync-storage.js';

const dirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'garbanzo-matrix-sync-'));
  dirs.push(dir);
  return join(dir, 'matrix-sync.json');
}

describe('Matrix sync-token storage', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a missing sync-token file as a fresh sync', () => {
    const storage = new MatrixSyncTokenStorageProvider(tempPath());
    expect(storage.getSyncToken()).toBeNull();
  });

  it('tolerates a corrupt sync-token file as a fresh sync', () => {
    const path = tempPath();
    writeFileSync(path, '{ nope', 'utf8');

    const storage = new MatrixSyncTokenStorageProvider(path);
    expect(storage.getSyncToken()).toBeNull();
  });

  it('roundtrips the sync token with an atomic JSON write', () => {
    const path = tempPath();
    const storage = new MatrixSyncTokenStorageProvider(path);

    storage.setSyncToken('s123');

    expect(storage.getSyncToken()).toBe('s123');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ syncToken: 's123' });
  });
});
