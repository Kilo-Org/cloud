import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

// Integration tests - run in Cloudflare Workers runtime via Miniflare
// Use cloudflare:test utilities: env, runInDurableObject, createMessageBatch, etc.
export default defineWorkersProject({
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
    poolOptions: {
      workers: {
        singleWorker: true,
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
      },
    },
  },
});
