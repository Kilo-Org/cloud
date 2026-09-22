import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const kCurrentWorker = Symbol.for('miniflare.kCurrentWorker');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Worker unit tests must not inherit the developer-local `.dev.vars`
        // `PUSH_SINK_MODE=log` that the E2E stack enables: the sink would
        // replace the real Expo send and make the dispatch tests observe
        // `delivered` instead of the ticket outcomes they assert. Pin the
        // production default-off value here; the sink tests opt in explicitly
        // through `setPushSinkModeForTesting`.
        bindings: { PUSH_SINK_MODE: '' },
        serviceBindings: {
          EVENT_SERVICE: 'event-service-stub',
          SELF: kCurrentWorker,
        },
        workers: [
          {
            name: 'event-service-stub',
            modules: true,
            script: `
              import { WorkerEntrypoint } from 'cloudflare:workers';
              export default class EventServiceStub extends WorkerEntrypoint {
                async fetch() { return new Response('ok'); }
                async isUserInContext() { return false; }
              }
            `,
          },
        ],
      },
    }),
  ],
  test: {
    passWithNoTests: true,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
