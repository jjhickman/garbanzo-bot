import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveHomeFrom } from '../src/utils/paths.js';

// ── resolveHomeFrom: pure-function topology matrix ──────────────────────────
//
// The four real-world topologies map onto (garbanzoHomeEnv, packagedSentinelExists):
//   - source checkout        -> (undefined, false)
//   - Docker /app image      -> ('/app', false|true — env always wins)
//   - `npm i -g garbanzo-bot`-> (undefined, true)
//   - `npx garbanzo-bot`     -> (undefined, true) — same sentinel-driven path as -g

describe('resolveHomeFrom (pure)', () => {
  const packageRoot = '/repo';
  const home = '/home/operator';

  it('source checkout: no env, no sentinel -> repo mode (packageRoot)', () => {
    expect(resolveHomeFrom({
      garbanzoHomeEnv: undefined,
      packagedSentinelExists: false,
      packageRoot,
      homedir: home,
    })).toBe(packageRoot);
  });

  it('Docker /app image layout: explicit GARBANZO_HOME wins even with no sentinel', () => {
    expect(resolveHomeFrom({
      garbanzoHomeEnv: '/app',
      packagedSentinelExists: false,
      packageRoot,
      homedir: home,
    })).toBe('/app');
  });

  it('npm i -g / npx cache install: sentinel present, no env -> ~/.garbanzo', () => {
    expect(resolveHomeFrom({
      garbanzoHomeEnv: undefined,
      packagedSentinelExists: true,
      packageRoot,
      homedir: home,
    })).toBe(join(home, '.garbanzo'));
  });

  it('env beats sentinel when both are present', () => {
    expect(resolveHomeFrom({
      garbanzoHomeEnv: '/custom/home',
      packagedSentinelExists: true,
      packageRoot,
      homedir: home,
    })).toBe('/custom/home');
  });

  it('treats an empty/whitespace-only env value as unset, falling through to the sentinel', () => {
    expect(resolveHomeFrom({
      garbanzoHomeEnv: '   ',
      packagedSentinelExists: true,
      packageRoot,
      homedir: home,
    })).toBe(join(home, '.garbanzo'));
  });

  it('treats an empty env value as unset, falling through to repo mode', () => {
    expect(resolveHomeFrom({
      garbanzoHomeEnv: '',
      packagedSentinelExists: false,
      packageRoot,
      homedir: home,
    })).toBe(packageRoot);
  });

  it('resolves a relative env value to an absolute path', () => {
    const result = resolveHomeFrom({
      garbanzoHomeEnv: 'relative-home',
      packagedSentinelExists: false,
      packageRoot,
      homedir: home,
    });
    expect(result).toBe(resolve('relative-home'));
    expect(result).not.toBe('relative-home');
  });
});

// ── Wired module: repo-mode assertions ──────────────────────────────────────
//
// This repo checkout never ships a dist/.packaged sentinel and the test run
// doesn't set GARBANZO_HOME, so the wired module must resolve to repo mode —
// every root coincides, matching today's PROJECT_ROOT-based behavior exactly.

describe('wired module (repo mode)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('PACKAGE_ROOT points at the real project root', async () => {
    const { PACKAGE_ROOT } = await import('../src/utils/paths.js');
    expect(existsSync(join(PACKAGE_ROOT, 'package.json'))).toBe(true);
  });

  it('is not a packaged install and GARBANZO_HOME_DIR coincides with PACKAGE_ROOT', async () => {
    const { PACKAGE_ROOT, GARBANZO_HOME_DIR, isPackagedInstall } = await import('../src/utils/paths.js');
    expect(isPackagedInstall()).toBe(false);
    expect(GARBANZO_HOME_DIR).toBe(PACKAGE_ROOT);
  });

  it('assetPath and homePath resolve identically in repo mode', async () => {
    const { PACKAGE_ROOT, assetPath, homePath } = await import('../src/utils/paths.js');
    expect(assetPath('config', 'groups.json')).toBe(homePath('config', 'groups.json'));
    expect(assetPath('docs', 'PERSONA.md')).toBe(resolve(PACKAGE_ROOT, 'docs', 'PERSONA.md'));
    expect(homePath('data', 'garbanzo.db')).toBe(resolve(PACKAGE_ROOT, 'data', 'garbanzo.db'));
  });
});

// ── Wired module: packaged sentinel topology ────────────────────────────────

describe('wired module (packaged sentinel)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('fs');
    vi.doUnmock('os');
  });

  it('treats a present dist/.packaged sentinel as an installed (npm -g / npx) topology', async () => {
    vi.resetModules();
    vi.doMock('fs', () => ({
      existsSync: vi.fn(() => true),
    }));
    vi.doMock('os', () => ({
      homedir: () => '/home/fake-operator',
    }));

    const originalGarbanzoHome = process.env.GARBANZO_HOME;
    delete process.env.GARBANZO_HOME;

    try {
      const mod = await import('../src/utils/paths.js');
      expect(mod.isPackagedInstall()).toBe(true);
      expect(mod.GARBANZO_HOME_DIR).toBe(join('/home/fake-operator', '.garbanzo'));
    } finally {
      if (originalGarbanzoHome === undefined) {
        delete process.env.GARBANZO_HOME;
      } else {
        process.env.GARBANZO_HOME = originalGarbanzoHome;
      }
    }
  });
});

// ── Env layering honors GARBANZO_HOME ───────────────────────────────────────
//
// applyEnvLayers({ baseDir: GARBANZO_HOME_DIR, ... }) must read .env from the
// resolved home directory, not PACKAGE_ROOT — this is the wiring in
// src/utils/config/index.ts that makes an npx install's mutable state land in
// ~/.garbanzo instead of the (potentially read-only) npm cache.

describe('config env layering honors GARBANZO_HOME', () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  afterEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    exitSpy.mockClear();
    errorSpy.mockClear();
    tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('reads .env from the resolved GARBANZO_HOME directory, not PACKAGE_ROOT', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'garbanzo-home-'));
    tempDirs.push(homeDir);
    writeFileSync(
      join(homeDir, '.env'),
      'GARBANZO_HOME_TEST_MARKER=marker_from_home\nOPENROUTER_API_KEY=test_key_ci\nAI_PROVIDER_ORDER=openrouter\n',
    );

    vi.resetModules();
    process.env = {
      ...originalEnv,
      GARBANZO_HOME: homeDir,
      MESSAGING_PLATFORM: 'discord',
    };
    delete process.env.GARBANZO_HOME_TEST_MARKER;

    const pathsModule = await import('../src/utils/paths.js');
    expect(pathsModule.GARBANZO_HOME_DIR).toBe(homeDir);

    const configModule = await import('../src/utils/config.js');
    expect(configModule.loadedEnvFiles).toEqual([join(homeDir, '.env')]);
    expect(process.env.GARBANZO_HOME_TEST_MARKER).toBe('marker_from_home');
    expect(configModule.config.AI_PROVIDER_ORDER).toBe('openrouter');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('falls back to PACKAGE_ROOT (repo mode) when GARBANZO_HOME is unset', async () => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      MESSAGING_PLATFORM: 'discord',
      OPENROUTER_API_KEY: 'test_key_ci',
      AI_PROVIDER_ORDER: 'openrouter',
    };
    delete process.env.GARBANZO_HOME;

    const pathsModule = await import('../src/utils/paths.js');
    const configModule = await import('../src/utils/config.js');

    expect(pathsModule.GARBANZO_HOME_DIR).toBe(pathsModule.PACKAGE_ROOT);
    expect(configModule.PROJECT_ROOT).toBe(pathsModule.PACKAGE_ROOT);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ── No-stale-sentinel regression (T6 hard gate) ─────────────────────────────
//
// dist/.packaged is written ONLY by the publish/pack build (package.json
// "prepack" -> scripts/pack-sentinel.mjs write) and removed immediately after
// by "postpack". A plain `npm run build` (tsc only) must never leave the
// sentinel behind in a repo checkout's dist/ — if it did, every subsequent
// repo-mode run would misresolve GARBANZO_HOME_DIR to ~/.garbanzo instead of
// PACKAGE_ROOT (isPackagedInstall() above treats a present sentinel as an
// installed topology, no questions asked).
describe('no stale packaged sentinel after a plain build', () => {
  // A cold tsc on a CI runner can exceed vitest's 5s default (same pattern
  // as the helm lint test): give the compile an explicit budget.
  it('dist/.packaged does not exist after `npm run build`', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const sentinelPath = join(repoRoot, 'dist', '.packaged');

    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe', timeout: 110_000 });

    expect(existsSync(sentinelPath)).toBe(false);
  }, 120_000);
});
