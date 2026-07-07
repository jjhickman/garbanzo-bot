/**
 * GARBANZO_HOME mode resolution and path helpers.
 *
 * Imports node builtins ONLY — no config imports — to avoid import cycles
 * (src/utils/config/index.ts imports from this module).
 *
 * Two families of paths:
 *   - assetPath(...) — read-only files shipped with the install (persona
 *     defaults, docs/personas/, templates/, postgres-schema.sql, package.json,
 *     CHANGELOG.md). Always resolved against PACKAGE_ROOT.
 *   - homePath(...) — mutable operator state (data/, config/*.json,
 *     baileys_auth/, .env files). Resolved against GARBANZO_HOME_DIR, which is
 *     PACKAGE_ROOT in repo/Docker mode and ~/.garbanzo in a packaged
 *     (npm-installed) mode.
 *
 * Repo checkouts and the Docker image never contain the dist/.packaged
 * sentinel, so GARBANZO_HOME_DIR === PACKAGE_ROOT there and assetPath/homePath
 * resolve identically to the historical PROJECT_ROOT-based paths — byte
 * identical behavior is the hard invariant for this module.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const processWithPkg = process as NodeJS.Process & { pkg?: unknown };

/**
 * Root of the package install (repo checkout, Docker image, or npm package
 * directory). Computed identically to the historical PROJECT_ROOT in
 * src/utils/config/index.ts, but one directory hop shallower because this
 * module lives at dist/utils/paths.js instead of dist/utils/config/index.js.
 */
export const PACKAGE_ROOT = processWithPkg.pkg
  ? dirname(process.execPath)
  : resolve(__dirname, '../..');

export interface ResolveHomeInput {
  garbanzoHomeEnv: string | undefined;
  packagedSentinelExists: boolean;
  packageRoot: string;
  homedir: string;
}

/**
 * Pure decision function for GARBANZO_HOME resolution. Precedence:
 *   1. GARBANZO_HOME env var, if non-empty — always wins. The Dockerfile sets
 *      this explicitly (GARBANZO_HOME=/app) so container mode is explicit,
 *      not inferred.
 *   2. Packaged sentinel present (dist/.packaged, written only by the publish
 *      build) → installed mode → home is `${homedir}/.garbanzo`.
 *   3. Otherwise → repo mode → packageRoot, byte-identical to today.
 */
export function resolveHomeFrom(input: ResolveHomeInput): string {
  const envValue = input.garbanzoHomeEnv?.trim();
  if (envValue) {
    return resolve(envValue);
  }

  if (input.packagedSentinelExists) {
    return join(input.homedir, '.garbanzo');
  }

  return input.packageRoot;
}

let cachedIsPackagedInstall: boolean | undefined;

/** True when a publish-build sentinel is present under PACKAGE_ROOT. Memoized. */
export function isPackagedInstall(): boolean {
  if (cachedIsPackagedInstall === undefined) {
    cachedIsPackagedInstall = existsSync(join(PACKAGE_ROOT, 'dist', '.packaged'));
  }
  return cachedIsPackagedInstall;
}

/** Resolved GARBANZO_HOME directory for this process. */
export const GARBANZO_HOME_DIR = resolveHomeFrom({
  garbanzoHomeEnv: process.env.GARBANZO_HOME,
  packagedSentinelExists: isPackagedInstall(),
  packageRoot: PACKAGE_ROOT,
  homedir: homedir(),
});

/** Resolve a path to a read-only asset shipped with the install. */
export function assetPath(...segments: string[]): string {
  return resolve(PACKAGE_ROOT, ...segments);
}

/** Resolve a path to mutable operator state under GARBANZO_HOME. */
export function homePath(...segments: string[]): string {
  return resolve(GARBANZO_HOME_DIR, ...segments);
}
