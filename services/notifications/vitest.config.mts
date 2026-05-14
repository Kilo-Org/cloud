import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const kCurrentWorker = Symbol.for('miniflare.kCurrentWorker');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
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
