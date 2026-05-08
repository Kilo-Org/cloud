import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Self-referencing symbol: miniflare resolves this to the current (runner) worker,
// letting tests call RPC methods on our own entrypoint.
const kCurrentWorker = Symbol.for('miniflare.kCurrentWorker');

export default defineWorkersConfig({
  test: {
    setupFiles: ['./src/__tests__/setup.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        isolatedStorage: false,
        miniflare: {
          serviceBindings: {
            EVENT_SERVICE_SELF: kCurrentWorker as unknown as string,
          },
        },
      },
    },
  },
});
