import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// ESM's node:fs export bindings aren't reconfigurable, so vi.spyOn can't
// patch renameSync directly — mock the module instead, gated by a flag the
// "IO race" test flips on and resets. Every other test leaves the flag
// false, so real fs behavior passes through untouched.
let renameSyncShouldThrow = false;
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameSyncShouldThrow) throw new Error('EBUSY: resource busy or locked');
      return actual.renameSync(...args);
    },
  };
});

import {
  createMatrixStorageProvider,
  MatrixSyncTokenStorageProvider,
  type MatrixStorageProvider,
} from '../src/platforms/matrix/sync-storage.js';

// Mimics SimpleFsStorageProvider: a MISSING file is fine (fresh store), but
// corrupt JSON throws — so quarantineCorruptSyncFile must run before this
// constructor sees the path.
class FakeSdkProvider implements MatrixStorageProvider {
  constructor(providerPath: string) {
    try {
      JSON.parse(readFileSync(providerPath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  getSyncToken(): string | null { return null; }
  setSyncToken(): void {}
}

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

  it('does not clobber a prior quarantine — increments to .corrupt.1, .corrupt.2, ...', () => {
    const path = tempPath();
    writeFileSync(path, '{ still not json', 'utf8');
    writeFileSync(`${path}.corrupt`, 'previous quarantine 0', 'utf8');
    writeFileSync(`${path}.corrupt.1`, 'previous quarantine 1', 'utf8');

    const provider = createMatrixStorageProvider(FakeSdkProvider as never, path);

    expect(provider).toBeInstanceOf(FakeSdkProvider);
    // Earlier quarantines are untouched...
    expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe('previous quarantine 0');
    expect(readFileSync(`${path}.corrupt.1`, 'utf8')).toBe('previous quarantine 1');
    // ...and the new one lands in the next free slot.
    expect(readFileSync(`${path}.corrupt.2`, 'utf8')).toBe('{ still not json');
  });

  it('degrades to the fallback token store instead of throwing when quarantining a corrupt store itself fails (IO race)', () => {
    const path = tempPath();
    writeFileSync(path, '{ nope', 'utf8');
    renameSyncShouldThrow = true;

    try {
      // The corrupt file is still in place (quarantine failed), so
      // FakeSdkProvider's own constructor throws on it too — exactly the
      // "SDK provider construction throws" path, proving the whole chain
      // degrades to MatrixSyncTokenStorageProvider rather than the process
      // crashing on an uncaught renameSync error during startup.
      let provider: MatrixStorageProvider | undefined;
      expect(() => {
        provider = createMatrixStorageProvider(FakeSdkProvider as never, path);
      }).not.toThrow();

      expect(provider).toBeInstanceOf(MatrixSyncTokenStorageProvider);
      expect(readFileSync(path, 'utf8')).toBe('{ nope');
    } finally {
      renameSyncShouldThrow = false;
    }
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
