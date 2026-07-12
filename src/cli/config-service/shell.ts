import { existsSync, readFileSync, statSync } from 'node:fs';
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

export function createSpaAssets(webDist = DEFAULT_WEB_DIST): SpaAssets {
  const root = resolve(webDist);
  const indexPath = resolve(root, 'index.html');

  return {
    index: () => existsSync(indexPath)
      ? { body: readFileSync(indexPath), contentType: CONTENT_TYPES['.html'] as string }
      : { body: FALLBACK_HTML, contentType: CONTENT_TYPES['.html'] as string, fallback: true },
    asset: (pathname) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        return null;
      }
      if (!decoded.startsWith('/assets/')) return null;
      const path = resolve(root, `.${decoded}`);
      const rel = relative(root, path);
      if (rel.startsWith('..') || !existsSync(path) || !statSync(path).isFile()) return null;
      return {
        body: readFileSync(path),
        contentType: CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      };
    },
  };
}
