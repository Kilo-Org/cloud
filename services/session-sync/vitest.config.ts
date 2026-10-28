import { createRequire } from 'node:module';

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Load the CommonJS builds of `pg-protocol` and `pg-pool`. Their ESM entry
 * points are `.js` files in packages without `"type": "module"`, which the
 * Workers pool parses as CommonJS.
 */
function fixPgCjsDependencies() {
  return {
    name: 'fix-pg-cjs-dependencies',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (importer === undefined) return undefined;
      if (source === 'pg-protocol') {
        return createRequire(importer).resolve('pg-protocol/dist/index.js');
      }
      if (source === 'pg-pool') return createRequire(importer).resolve(source);
      return undefined;
    },
  };
}

// Every suite runs in the Workers runtime against real Durable Object and R2 bindings.
export default defineConfig({
  plugins: [
    fixPgCjsDependencies(),
    cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } }),
  ],
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
