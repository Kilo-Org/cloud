import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL } from 'node:url';

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { parse } from 'jsonc-parser';
import { configDefaults, defineConfig } from 'vitest/config';
import { z } from 'zod';

const { vars: bindings } = z
  .object({ vars: z.record(z.string(), z.string()) })
  .parse(parse(readFileSync(new URL('./wrangler.test.jsonc', import.meta.url), 'utf8')));

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

/** Loops of tens of sequential requests; they need their own worker and deadline. */
const SLOW_SUITES = ['lease-granularity.test.ts', 'live-relay.test.ts'];

// Every suite runs in the Workers runtime against real Durable Object and R2 bindings.
export default defineConfig({
  plugins: [
    fixPgCjsDependencies(),
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: { bindings },
    }),
  ],
  test: {
    globals: true,
    env: { SESSION_SYNC_MEASURE_URL: process.env.SESSION_SYNC_MEASURE_URL ?? '' },
    // Suites that drive long request loops keep their own worker and deadline, so
    // a growing default suite cannot starve them past the shared timeout.
    projects: [
      {
        extends: true,
        test: {
          name: 'default',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: [
            ...configDefaults.exclude,
            'test/postgres/**',
            ...SLOW_SUITES.map(path => `**/${path}`),
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'slow',
          include: SLOW_SUITES.map(path => `test/integration/${path}`),
          testTimeout: 20_000,
        },
      },
    ],
  },
});
