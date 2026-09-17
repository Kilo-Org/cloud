import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// e2e-surface tests in the real Workers runtime (Miniflare). This is a separate
// config from `vitest.workers.config.ts`: it exercises the real `src/e2e-entry.ts`
// and the real Durable Object classes, not `test/test-worker.ts`.
//
// `HYPERDRIVE` is mandatory because `authMiddleware` dereferences
// `env.HYPERDRIVE.connectionString` before it can reject a missing token, and the
// allocation route's `requireCurrentSessionAccess` queries PostgreSQL. The
// database is the same local/CI Postgres the rest of the repo uses; point
// `E2E_TEST_DATABASE_URL` (or `POSTGRES_URL`) at it, or keep the default
// `postgres://postgres:postgres@localhost:5432/postgres`.
const databaseUrl =
  process.env.E2E_TEST_DATABASE_URL ??
  process.env.POSTGRES_URL ??
  'postgres://postgres:postgres@localhost:5432/postgres';
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??= databaseUrl;

export default defineConfig({
  plugins: [
    {
      name: 'fix-pg-cjs-dependencies',
      enforce: 'pre',
      resolveId(source: string, importer?: string) {
        if (importer === undefined) return undefined;
        if (source === 'pg-protocol') {
          return createRequire(importer).resolve('pg-protocol/dist/index.js');
        }
        if (source === 'pg-pool') return createRequire(importer).resolve(source);
        if (source === 'pg-cloudflare') {
          // The package's workerd export condition maps `require` to a CJS file
          // that the CJS shim cannot resolve through `exports`. Resolve the
          // package root (its ./package.json is exported) and hand the shim the
          // real CJS file.
          const packageJson = createRequire(importer).resolve('pg-cloudflare/package.json');
          return join(dirname(packageJson), 'dist/index.js');
        }
        return undefined;
      },
    },
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.e2e-workers.jsonc',
      },
      miniflare: {
        compatibilityFlags: ['service_binding_extra_handlers'],
      },
    }),
  ],
  test: {
    name: 'e2e-workers',
    globals: true,
    include: ['test/e2e/workers/**/*.test.ts'],
  },
});
