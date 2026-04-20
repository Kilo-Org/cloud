import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Point the KILOCLAW service binding at the stub worker below.
          // It must be a named worker reference (not a plain Response function)
          // because the queue handler calls KILOCLAW.deliverChatWebhook() via
          // RPC, which requires a WorkerEntrypoint — plain HTTP stubs don't
          // support RPC and cause intermittent workerd "Failed to get handler
          // to worker" errors.
          serviceBindings: {
            KILOCLAW: 'kiloclaw-stub',
            EVENT_SERVICE: 'event-service-stub',
          },
          workers: [
            {
              name: 'kiloclaw-stub',
              modules: true,
              script: `
                import { WorkerEntrypoint } from 'cloudflare:workers';
                export default class KiloclawStub extends WorkerEntrypoint {
                  async deliverChatWebhook(_payload) {
                    // no-op stub — webhook delivery is not tested here
                  }
                }
              `,
            },
            {
              name: 'event-service-stub',
              modules: true,
              script: `
                import { WorkerEntrypoint } from 'cloudflare:workers';
                export default class EventServiceStub extends WorkerEntrypoint {
                  async fetch(request) {
                    return new Response('ok');
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
