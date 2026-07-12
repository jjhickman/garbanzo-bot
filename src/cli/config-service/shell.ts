import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../../web/dist/', import.meta.url));
const FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Garbanzo configuration</title></head><body><main><h1>Garbanzo configuration</h1>
<p>The browser app has not been built. Run <code>npm run build:web</code>, then restart <code>garbanzo config</code>.</p>
</main></body></html>`;

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export interface SpaAsset {
  body: Buffer | string;
  contentType: string;
  fallback?: boolean;
}

export interface SpaAssets {
  index(): SpaAsset;
  asset(pathname: string): SpaAsset | null;
}

/**
 * Reads a file only if it is a real regular file whose fully symlink-resolved
 * path stays inside `realRoot`. The static shell and asset routes are served
 * unauthenticated, so a symlink planted in `web/dist` (poisoned build artifact,
 * writable install, compromised build dependency) must never turn `/` or
 * `/assets/*` into an arbitrary-file-read: lexical `..` rejection is not enough
 * because `statSync`/`readFileSync` follow symlinks. `lstatSync` rejects a
 * symlinked final component and `realpathSync` collapses any symlinked parent
 * directory before the containment check.
 */
function readContained(realRoot: string, candidate: string): Buffer | null {
  try {
    if (lstatSync(candidate).isSymbolicLink()) return null;
    const real = realpathSync(candidate);
    if (relative(realRoot, real).startsWith('..')) return null;
    if (!lstatSync(real).isFile()) return null;
    return readFileSync(real);
  } catch {
    return null;
  }
}

export function createSpaAssets(webDist = DEFAULT_WEB_DIST): SpaAssets {
  const root = resolve(webDist);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  const indexPath = resolve(root, 'index.html');

  return {
    index: () => {
      const body = readContained(realRoot, indexPath);
      return body
        ? { body, contentType: CONTENT_TYPES['.html'] as string }
        : { body: FALLBACK_HTML, contentType: CONTENT_TYPES['.html'] as string, fallback: true };
    },
    asset: (pathname) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        return null;
      }
      if (!decoded.startsWith('/assets/')) return null;
      const path = resolve(root, `.${decoded}`);
      if (relative(root, path).startsWith('..')) return null;
      const body = readContained(realRoot, path);
      if (!body) return null;
      return {
        body,
        contentType: CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      };
    },
  };
}
