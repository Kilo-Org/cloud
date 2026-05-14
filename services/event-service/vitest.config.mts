import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Self-referencing symbol: miniflare resolves this to the current (runner) worker,
// letting tests call RPC methods on our own entrypoint.
const kCurrentWorker = Symbol.for('miniflare.kCurrentWorker');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        serviceBindings: {
          EVENT_SERVICE_SELF: kCurrentWorker,
        },
      },
    }),
  ],
  test: {
    isolate: false,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
