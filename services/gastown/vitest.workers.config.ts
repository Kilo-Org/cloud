import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Integration tests - run in Cloudflare Workers runtime via Miniflare
export default defineConfig({
  resolve: {
    alias: {
      '@cloudflare/containers': fileURLToPath(
        new URL('./test/integration/mocks/cloudflare-containers.ts', import.meta.url)
      ),
    },
  },
  plugins: [
    {
      // Match Cloud Agent's Workers harness: pg's CommonJS require must
      // resolve its dependencies to CommonJS rather than their ESM exports.
      name: 'fix-pg-cjs-dependencies',
      enforce: 'pre',
      resolveId(source: string, importer?: string) {
        if (importer === undefined) return undefined;
        if (source === 'pg-protocol') {
          return createRequire(importer).resolve('pg-protocol/dist/index.js');
        }
        if (source === 'pg-pool') return createRequire(importer).resolve(source);
        return undefined;
      },
    },
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
  },
});
