import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';

/**
 * Fails the build if the emitted index.html carries any inline script or style,
 * which our config-service CSP (`script-src 'self'; style-src 'self'`) would
 * refuse to execute. Runs at closeBundle and reads the real file from the
 * output dir: under vite 8 (rolldown) the HTML is written to disk directly and
 * is not present in the generateBundle `bundle` map, so inspecting the artifact
 * on disk is both correct and version-robust.
 */
function rejectInlineAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'garbanzo-csp-no-inline-assets',
    configResolved(config: ResolvedConfig) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      let html: string;
      try {
        html = readFileSync(resolve(outDir, 'index.html'), 'utf8');
      } catch {
        throw new Error('Vite did not emit index.html');
      }
      if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) || /<style(?:\s|>)/i.test(html) || /\sstyle=/i.test(html)) {
        throw new Error('CSP violation: production index.html contains inline script or style content');
      }
    },
  };
}

export default defineConfig({
  plugins: [svelte(), rejectInlineAssets()],
  build: {
    assetsDir: 'assets',
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
