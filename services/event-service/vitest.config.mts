import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          serviceBindings: {
            KILO_CHAT: 'kilo-chat-stub',
          },
          workers: [
            {
              name: 'kilo-chat-stub',
              modules: true,
              script: `
                import { WorkerEntrypoint } from 'cloudflare:workers';
                export default class KiloChatStub extends WorkerEntrypoint {
                  async rpc(userId, method, payload) {
                    return { echo: { userId, method, payload } };
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
