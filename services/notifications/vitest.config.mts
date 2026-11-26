import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const kCurrentWorker = Symbol.for('miniflare.kCurrentWorker');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Worker unit tests must not inherit the developer-local `.dev.vars`
        // `PUSH_SINK_MODE=log` that the E2E stack enables: the sink would
        // replace the real Expo send and make the dispatch tests observe
        // `delivered` instead of the ticket outcomes they assert. Pin the
        // production default-off value here; the sink tests opt in explicitly
        // through `setPushSinkModeForTesting`.
        bindings: { PUSH_SINK_MODE: '' },
        // Worker unit tests resolve the STS binding to a local stub, never the
        // deployed broker. The binding mirrors wrangler.jsonc: the named
        // `SecretsBroker` entrypoint with `props.caller`. The stub refuses every
        // bundle; a test of the `sts` source injects its own synthetic binding.
        serviceBindings: {
          EVENT_SERVICE: 'event-service-stub',
          STS: {
            name: 'sts-stub',
            entrypoint: 'SecretsBroker',
            props: { caller: 'notifications' },
          },
          SELF: kCurrentWorker,
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
          {
            name: 'sts-stub',
            modules: true,
            script: `
              import { WorkerEntrypoint } from 'cloudflare:workers';
              export class SecretsBroker extends WorkerEntrypoint {
                async getBundle() {
                  return { status: 'denied', reason: 'unknown_workload' };
                }
              }
            `,
          },
        ],
      },
    }),
  ],
  test: {
    passWithNoTests: true,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
