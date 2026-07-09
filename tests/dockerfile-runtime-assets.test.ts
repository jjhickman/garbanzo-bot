import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const dockerfilePath = resolve(process.cwd(), 'Dockerfile');
const packageJsonPath = resolve(process.cwd(), 'package.json');
const packageLockPath = resolve(process.cwd(), 'package-lock.json');
const matrixCryptoStubPackagePath = resolve(process.cwd(), 'stubs/matrix-sdk-crypto-nodejs/package.json');

describe('Docker runtime assets', () => {
  it('includes postgres schema SQL in runtime image', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf-8');
    expect(dockerfile).toContain('/app/src/utils/postgres-schema.sql');
    expect(dockerfile).toContain('./src/utils/postgres-schema.sql');
  });

  it('includes platform persona docs in runtime image', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf-8');
    expect(dockerfile).toContain('docs/personas/');
    expect(dockerfile).toContain('./docs/personas/');
  });

  it('keeps Matrix native crypto off the Docker npm install path', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf-8');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };
    const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf-8')) as {
      packages?: Record<string, { resolved?: string; hasInstallScript?: boolean; link?: boolean }>;
    };
    const stubPackage = JSON.parse(readFileSync(matrixCryptoStubPackagePath, 'utf-8')) as {
      name?: string;
      scripts?: Record<string, string>;
    };

    expect(dockerfile).toContain('COPY stubs/ ./stubs/');
    // The crypto stub is a file: dependency → npm links it as a SYMLINK into
    // node_modules pointing at stubs/. The multi-stage runtime image must ALSO
    // carry stubs/, or that symlink dangles and matrix-bot-sdk (imported only
    // by the Matrix runtime, which CI never boots) crash-loops with "Cannot
    // find module". Guard the runtime-stage copy so this can't regress.
    expect(packageLock.packages?.['node_modules/@matrix-org/matrix-sdk-crypto-nodejs']?.link).toBe(true);
    expect(dockerfile).toContain('COPY --from=builder --chown=garbanzo:garbanzo /app/stubs ./stubs');
    expect(packageJson.dependencies?.['@matrix-org/matrix-sdk-crypto-nodejs']).toBe(
      'file:stubs/matrix-sdk-crypto-nodejs',
    );
    expect(packageJson.overrides?.['@matrix-org/matrix-sdk-crypto-nodejs']).toBe(
      '$@matrix-org/matrix-sdk-crypto-nodejs',
    );
    expect(stubPackage.name).toBe('@matrix-org/matrix-sdk-crypto-nodejs');
    expect(stubPackage.scripts?.postinstall).toBeUndefined();
    expect(packageLock.packages?.['node_modules/@matrix-org/matrix-sdk-crypto-nodejs']).toMatchObject({
      resolved: 'stubs/matrix-sdk-crypto-nodejs',
    });
    expect(packageLock.packages?.['node_modules/@matrix-org/matrix-sdk-crypto-nodejs']?.hasInstallScript).toBeUndefined();
  });
});
