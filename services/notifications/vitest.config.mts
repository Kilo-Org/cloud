import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

const kCurrentWorker = Symbol.for('miniflare.kCurrentWorker');

export default defineWorkersConfig({
  test: {
    passWithNoTests: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          serviceBindings: {
            EVENT_SERVICE: 'event-service-stub',
            SELF: kCurrentWorker as unknown as string,
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
      },
    },
  },
});
