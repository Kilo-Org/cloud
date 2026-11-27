import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Self-referencing symbol: miniflare resolves this to the current (runner) worker,
// letting tests call RPC methods on our own entrypoint.
const kCurrentWorker = Symbol.for('miniflare.kCurrentWorker');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
      miniflare: {
        serviceBindings: {
          EVENT_SERVICE_SELF: kCurrentWorker,
          // The wrangler config binds the deployed `sts`; tests resolve that name to the stub.
          STS: 'sts-stub',
        },
        // Worker unit tests resolve the STS binding to the stub below instead of the deployed
        // broker. The binding names the `SecretsBroker` entrypoint, so the stub exports it.
        // Nothing reaches it while SECRETS_SOURCE is `env`.
        workers: [
          {
            name: 'sts-stub',
            modules: true,
            script: `
              import { WorkerEntrypoint } from 'cloudflare:workers';
              export class SecretsBroker extends WorkerEntrypoint {
                async getBundle() {
                  return { status: 'unavailable', reason: 'internal', retryAfterSeconds: 5 };
                }
              }
              export default class StsStub extends WorkerEntrypoint {
                async fetch() { return new Response('ok'); }
              }
            `,
          },
        ],
      },
    }),
  ],
  test: {
    // Disabled to avoid workerd crashes in the connection-ticket suite; revisit when upstream is fixed.
    isolate: false,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
