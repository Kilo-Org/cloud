import { createRequire } from 'node:module';

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

function fixPgCjsDependencies() {
  return {
    name: 'fix-pg-cjs-dependencies',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (importer === undefined) return undefined;

      if (source === 'pg-protocol') {
        return createRequire(importer).resolve('pg-protocol/dist/index.js');
      }

      if (source === 'pg-pool') {
        return createRequire(importer).resolve(source);
      }

      return undefined;
    },
  };
}

// Integration tests - run in Cloudflare Workers runtime via Miniflare
export default defineConfig({
  plugins: [
    fixPgCjsDependencies(),
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.test.jsonc',
      },
    }),
  ],
  test: {
    name: 'integration',
    globals: true,
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['test/integration/setup.ts'],
  },
});
