import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Integration tests - run in Cloudflare Workers runtime via Miniflare
// Use cloudflare:test utilities: env, runInDurableObject, createMessageBatch, etc.
export default defineConfig({
  plugins: [
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
  },
});
