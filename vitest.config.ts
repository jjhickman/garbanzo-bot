import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Two projects so the browser resolution the Svelte component tests need never
// leaks into the server suite: the server project keeps Node resolution exactly
// as it was before the web workspace existed, while the web project runs under
// jsdom with the `browser` export condition so `svelte`'s client build (whose
// `mount` works in a DOM) is picked instead of the SSR build.
export default defineConfig({
  plugins: [svelte()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          setupFiles: ['tests/vitest.setup.ts'],
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        resolve: { conditions: ['browser'] },
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/src/**/*.test.ts'],
        },
      },
    ],
  },
});
