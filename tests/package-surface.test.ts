import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type PackEntry = { path: string };
type PackResult = { files: PackEntry[] };

function pkg(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as Record<string, unknown>;
}

describe('published package surface', () => {
  // `npm pack --dry-run --json` reports exactly what a publish would ship
  // without writing a tarball. Slow-ish but hermetic; give it room.
  it('ships the Matrix crypto stub that the file: dependency points at', () => {
    // --ignore-scripts: skip prepack/postpack (which transiently write the
    // dist/.packaged sentinel and would race the sentinel-guard test). The
    // file manifest comes from the `files` whitelist + working tree, so it is
    // accurate without running the build.
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
      timeout: 60_000,
    });
    const parsed = JSON.parse(raw) as PackResult[];
    const files = parsed[0]?.files.map((f) => f.path) ?? [];

    // The stub is referenced as `file:stubs/matrix-sdk-crypto-nodejs`; if it
    // is not in the tarball, a fresh install resolves a dependency to a path
    // that does not exist. Guard the whole directory's payload.
    for (const needed of [
      'stubs/matrix-sdk-crypto-nodejs/package.json',
      'stubs/matrix-sdk-crypto-nodejs/index.js',
    ]) {
      expect(files, `${needed} missing from npm pack output`).toContain(needed);
    }
  }, 90_000);

  it('keeps matrix-bot-sdk optional so a bare-metal install never hard-fails', () => {
    const json = pkg();
    const deps = (json.dependencies ?? {}) as Record<string, string>;
    const optional = (json.optionalDependencies ?? {}) as Record<string, string>;

    // matrix-bot-sdk drags a native crypto postinstall with no arm64-musl
    // build; as an optional dep its install failure is non-fatal.
    expect(optional['matrix-bot-sdk']).toBeDefined();
    expect(deps['matrix-bot-sdk']).toBeUndefined();
  });
});
