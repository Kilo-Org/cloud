import { createRequire } from 'node:module';
import path from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

function fixPg() {
  return {
    name: 'fix-pg',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (importer === undefined) return undefined;
      if (source === 'pg-protocol') return createRequire(importer).resolve('pg-protocol/dist/index.js');
      if (source === 'pg-cloudflare') {
        const pkg = createRequire(importer).resolve('pg-cloudflare/package.json');
        void pkg; return '/tmp/kilo2/pgcf/index.js';
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [fixPg(), cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
  test: { name: 'scratch', globals: true, include: ['test/integration/zz-scratch-*.test.ts'], testTimeout: 60_000 },
});
