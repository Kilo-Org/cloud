import { createRequire } from 'node:module';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Integration tests - run in Cloudflare Workers runtime via Miniflare
// Use cloudflare:test utilities: env, runInDurableObject, createMessageBatch, etc.
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
        return undefined;
      },
    },
    cloudflareTest({
      wrangler: {
        // Use test-specific wrangler config that excludes Sandbox DO
        // (avoids @cloudflare/containers import issues)
        configPath: './wrangler.test.jsonc',
      },
      miniflare: {
        // Faster queue processing in tests
        queueConsumers: {
          EXECUTION_QUEUE: {
            maxBatchTimeout: 50,
          },
        },
        // Required for SELF.queue() testing
        compatibilityFlags: ['service_binding_extra_handlers'],
      },
    }),
  ],
  test: {
    name: 'integration',
    globals: true,
    include: ['test/integration/**/*.test.ts'],
    deps: {
      optimizer: {
        ssr: {
          include: ['@cloudflare/sandbox', '@cloudflare/containers'],
        },
      },
    },
  },
});
