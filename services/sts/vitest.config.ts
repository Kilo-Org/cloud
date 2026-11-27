import { createRequire } from 'node:module';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Load the CommonJS builds of `pg-protocol` and `pg-pool`, which the lease object's replica sweep
 * reaches through `src/leases/replica-sweep.ts`. Their ESM entry points are `.js` files in packages
 * without `"type": "module"`, which the Workers pool parses as CommonJS (as in services/uts).
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

export default defineConfig({
  plugins: [
    fixPgCjsDependencies(),
    cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } }),
  ],
  test: {
    include: ['test/worker/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
