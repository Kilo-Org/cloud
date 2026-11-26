import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
      miniflare: {
        // Worker unit tests resolve the STS binding to the stub below instead of the deployed
        // broker. The binding names the `SecretsBroker` entrypoint, so the stub exports it.
        serviceBindings: { STS: 'sts-stub' },
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
});
