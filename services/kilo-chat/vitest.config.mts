import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          serviceBindings: {
            // Stub the kiloclaw service binding for tests — RPC calls are not
            // exercised in unit tests; this prevents miniflare from failing to
            // resolve the external worker.
            KILOCLAW: {
              async fetch() {
                return new Response('{}', { status: 200 });
              },
            },
          },
        },
      },
    },
  },
});
