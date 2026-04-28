import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    setupFiles: ['./src/__tests__/setup.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          serviceBindings: {
            EVENT_SERVICE: 'event-service-stub',
          },
          workers: [
            {
              name: 'event-service-stub',
              modules: true,
              script: `
                import { WorkerEntrypoint } from 'cloudflare:workers';
                let inContextResult = false;
                export default class EventServiceStub extends WorkerEntrypoint {
                  async fetch(request) {
                    return new Response('ok');
                  }
                  async isUserInContext(userId, context) {
                    return inContextResult;
                  }
                  async __setInContextResult(value) {
                    inContextResult = value;
                  }
                }
              `,
            },
          ],
        },
      },
    },
  },
});
