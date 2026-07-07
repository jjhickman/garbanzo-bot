#!/usr/bin/env node
/**
 * Writes or removes the dist/.packaged sentinel that marks a build as a
 * publish/pack artifact (see src/utils/paths.ts — GARBANZO_HOME mode
 * resolution). Wired into package.json as:
 *
 *   "prepack":  "npm run build && node scripts/pack-sentinel.mjs write"
 *   "postpack": "node scripts/pack-sentinel.mjs remove"
 *
 * npm runs prepack before building the tarball for both `npm pack` and
 * `npm publish`, and postpack immediately after — so the sentinel exists
 * only inside the tarball/published package, never in a plain repo
 * checkout's dist/ (a stale sentinel there would flip repo mode to
 * "packaged" and misresolve GARBANZO_HOME_DIR). `npm run build` alone
 * (tsc only) never touches this file.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENTINEL_PATH = resolve(ROOT, 'dist', '.packaged');

const mode = process.argv[2];

if (mode === 'write') {
  mkdirSync(dirname(SENTINEL_PATH), { recursive: true });
  writeFileSync(SENTINEL_PATH, `${new Date().toISOString()}\n`, 'utf-8');
  console.log(`Wrote packaged sentinel: ${SENTINEL_PATH}`);
} else if (mode === 'remove') {
  if (existsSync(SENTINEL_PATH)) {
    rmSync(SENTINEL_PATH, { force: true });
    console.log(`Removed packaged sentinel: ${SENTINEL_PATH}`);
  } else {
    console.log(`No packaged sentinel to remove at ${SENTINEL_PATH}`);
  }
} else {
  console.error('Usage: pack-sentinel.mjs <write|remove>');
  process.exit(1);
}
