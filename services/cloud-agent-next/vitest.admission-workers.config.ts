import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

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
          const packageJson = createRequire(importer).resolve('pg-cloudflare/package.json');
          return join(dirname(packageJson), 'dist/index.js');
        }
        return undefined;
      },
    },
    cloudflareTest({
      wrangler: { configPath: './wrangler.admission-workers.jsonc' },
    }),
  ],
  test: {
    name: 'admission-workers-postgres',
    include: ['test/admission-workers/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 15_000,
    deps: {
      optimizer: {
        ssr: { include: ['@cloudflare/sandbox', '@cloudflare/containers'] },
      },
    },
  },
});
