import { createRequire } from 'node:module';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { binaryAsArrayBuffer } from './test/plugins/binary-as-arraybuffer.js';
import { FAKE_DOWNLOADED_RUNTIME_ENV } from './test/integration/helpers/fake-credentials.js';

// Integration tests - run in Cloudflare Workers runtime via Miniflare
// Use cloudflare:test utilities: env, runInDurableObject, createMessageBatch, etc.
export default defineConfig({
  plugins: [
    binaryAsArrayBuffer,
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
        // Use the test-specific wrangler config with only the Durable Objects
        // the integration suite needs.
        configPath: './wrangler.test.jsonc',
      },
      miniflare: {
        bindings: {
          RUNTIME_STARTUP_MODE: 'downloaded',
          RUNTIME_RELEASE_DESCRIPTOR: FAKE_DOWNLOADED_RUNTIME_ENV.RUNTIME_RELEASE_DESCRIPTOR,
          NATIVE_RUNTIME_IMAGE: 'runtime-free',
        },
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
    setupFiles: ['./test/integration/helpers/setup-runtime.ts'],
    include: ['test/integration/**/*.test.ts'],
    // Each test drives real Durable Objects through workerd, and the suite
    // polls for up to its own 10 s budget (test/integration/wait-for.ts).
    // A smaller test budget fails a healthy wait before that budget ends.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    deps: {
      optimizer: {
        ssr: {
          include: ['@cloudflare/containers'],
        },
      },
    },
  },
});
