import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        wrappedBindings: {
          DISPATCH: 'fake-dispatch-namespace',
        },
        workers: [
          {
            name: 'fake-dispatch-namespace',
            modules: true,
            script: `
              const EXPECTED_WORKER_NAMES = new Set([
                'qdpl-runtime-regression',
                'dpl-persistent-worker',
              ]);

              class FakeDispatchNamespace {
                get(workerName) {
                  if (!EXPECTED_WORKER_NAMES.has(workerName)) {
                    throw new Error(\`Unexpected dispatched worker: \${workerName}\`);
                  }

                  return {
                    fetch(request) {
                      const url = new URL(request.url);
                      return Promise.resolve(
                        new Response(\`fake internal worker served \${workerName}\${url.pathname}\`, {
                          headers: { 'content-type': 'text/plain' },
                        })
                      );
                    },
                  };
                }
              }

              export default function createFakeDispatchNamespace() {
                return new FakeDispatchNamespace();
              }
            `,
          },
        ],
      },
      wrangler: {
        configPath: './wrangler.entrypoint.test.jsonc',
      },
    }),
  ],
  test: {
    name: 'dispatcher-entrypoint-integration',
    globals: true,
    include: ['test/dispatcher-entrypoint.integration.test.ts'],
  },
});
