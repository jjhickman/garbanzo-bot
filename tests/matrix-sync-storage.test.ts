import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createMatrixStorageProvider, MatrixSyncTokenStorageProvider } from '../src/platforms/matrix/sync-storage.js';

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

  it('quarantines a corrupt store before handing the path to the SDK provider', () => {
    const path = tempPath();
    writeFileSync(path, '{ definitely not json', 'utf8');
    const constructed: string[] = [];
    class FakeSdkProvider {
      // Mimics SimpleFsStorageProvider: a MISSING file is fine (fresh
      // store), but corrupt JSON throws — so the quarantine must run first.
      constructor(providerPath: string) {
        constructed.push(providerPath);
        try {
          JSON.parse(readFileSync(providerPath, 'utf8'));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      getSyncToken(): string | null { return null; }
      setSyncToken(): void {}
    }

    const provider = createMatrixStorageProvider(FakeSdkProvider as never, path);

    expect(provider).toBeInstanceOf(FakeSdkProvider);
    expect(constructed).toEqual([path]);
    expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe('{ definitely not json');
  });

  it('falls back to the token store when the SDK provider construction throws', () => {
    const path = tempPath();
    class ExplodingProvider {
      constructor() { throw new Error('sdk storage boom'); }
      getSyncToken(): string | null { return null; }
      setSyncToken(): void {}
    }

    const provider = createMatrixStorageProvider(ExplodingProvider as never, path);
    expect(provider).toBeInstanceOf(MatrixSyncTokenStorageProvider);
  });

  it('roundtrips the sync token with an atomic JSON write', () => {
    const path = tempPath();
    const storage = new MatrixSyncTokenStorageProvider(path);

    storage.setSyncToken('s123');

    expect(storage.getSyncToken()).toBe('s123');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ syncToken: 's123' });
  });
});
