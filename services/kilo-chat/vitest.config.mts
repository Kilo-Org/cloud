import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    // SSE stream tests trigger "Stream was cancelled" unhandled rejections
    // inside workerd's internal TransformStream when the test reader cancels
    // the response body. These are benign and unavoidable in this environment.
    dangerouslyIgnoreUnhandledErrors: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          serviceBindings: {
            // Stub the kiloclaw service binding for tests — RPC calls are not
            // exercised in unit tests; this prevents miniflare from failing to
            // resolve the external worker.
            KILOCLAW: () => new Response('{}', { status: 200 }),
          },
        },
      },
    },
  },
});
