import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: [{ find: /^(.*\.sql)$/, replacement: '$1?raw' }] },
  plugins: [
    cloudflareTest({
      // Storage tests must not load production bindings or environment files.
      main: './src/db/test-worker.ts',
      remoteBindings: false,
      miniflare: {
        compatibilityDate: '2026-06-05',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          STORE: { className: 'TestStore', useSQLite: true },
          OLD_STORE: { className: 'OldTestStore', useSQLite: true },
        },
      },
    }),
  ],
  test: { include: ['src/**/*.test.ts'], passWithNoTests: true },
});
