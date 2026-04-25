import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Self-referencing symbol: miniflare resolves this to the current (runner) worker,
// letting the destroy-sandbox test call the RPC method on our own entrypoint.
const kCurrentWorker = Symbol.for('miniflare.kCurrentWorker');

export default defineWorkersConfig({
  test: {
    setupFiles: ['./src/__tests__/setup.ts'],
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
            KILO_CHAT_SELF: kCurrentWorker as unknown as string,
          },
          workers: [
            {
              name: 'kiloclaw-stub',
              modules: true,
              script: `
                import { WorkerEntrypoint } from 'cloudflare:workers';
                // Recorded calls are kept in module scope so both the stub and
                // tests (via service-binding RPC) see the same array.
                const recorded = [];
                export default class KiloclawStub extends WorkerEntrypoint {
                  async deliverChatWebhook(payload) {
                    recorded.push(payload);
                  }
                  async __recordedWebhookCalls() {
                    return recorded.slice();
                  }
                  async __clearWebhookCalls() {
                    recorded.length = 0;
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
                  async pushEvent(userId, context, event, payload) {
                    return false;
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
