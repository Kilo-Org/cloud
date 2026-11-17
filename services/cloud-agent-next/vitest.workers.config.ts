import { createRequire } from 'node:module';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { FAKE_DOWNLOADED_RUNTIME_ENV } from './test/integration/helpers/fake-credentials.js';

// Minimal Session Sync double: it reports the upgrade headers the binding
// delivered and echoes frames so the test observes both directions.
const SESSION_SYNC_TEST_WORKER = `
export default {
  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('Expected WebSocket upgrade', { status: 426 });
    const protocol = request.headers.get('Sec-WebSocket-Protocol');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.send(JSON.stringify({
      path: new URL(request.url).pathname,
      upgrade: request.headers.get('Upgrade'),
      protocol,
      authorization: request.headers.get('Authorization'),
    }));
    server.addEventListener('message', event => server.send('echo:' + event.data));
    return new Response(null, {
      status: 101,
      webSocket: client,
      ...(protocol === null ? {} : { headers: { 'Sec-WebSocket-Protocol': protocol } }),
    });
  },
};
`;

// Integration tests - run in Cloudflare Workers runtime via Miniflare
// Use cloudflare:test utilities: env, runInDurableObject, createMessageBatch, etc.
export default defineConfig({
  plugins: [
    {
      name: 'fix-pg-cjs-dependencies',
      enforce: 'pre',
      resolveId(source: string, importer?: string) {
        if (importer === undefined) return undefined;
        if (source === 'pg-protocol') {
          return createRequire(importer).resolve('pg-protocol/dist/index.js');
        }
        if (source === 'pg-pool') return createRequire(importer).resolve(source);
        return undefined;
      },
    },
    cloudflareTest({
      wrangler: {
        // Use the test-specific wrangler config with only the Durable Objects
        // the integration suite needs.
        configPath: './wrangler.test.jsonc',
      },
      miniflare: {
        workers: [
          {
            name: 'session-sync-test',
            compatibilityDate: '2026-10-01',
            modules: true,
            script: SESSION_SYNC_TEST_WORKER,
          },
        ],
        bindings: {
          RUNTIME_STARTUP_MODE: 'downloaded',
          RUNTIME_RELEASE_DESCRIPTOR: FAKE_DOWNLOADED_RUNTIME_ENV.RUNTIME_RELEASE_DESCRIPTOR,
          NATIVE_RUNTIME_IMAGE: 'runtime-free',
        },
        // Faster queue processing in tests
        queueConsumers: {
          EXECUTION_QUEUE: {
            maxBatchTimeout: 50,
          },
        },
        // Required for SELF.queue() testing
        compatibilityFlags: ['service_binding_extra_handlers'],
      },
    }),
  ],
  test: {
    name: 'integration',
    globals: true,
    setupFiles: ['./test/integration/helpers/setup-runtime.ts'],
    include: ['test/integration/**/*.test.ts'],
    // Each test drives real Durable Objects through workerd, and the suite
    // polls for up to its own 10 s budget (test/integration/wait-for.ts).
    // A smaller test budget fails a healthy wait before that budget ends.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    deps: {
      optimizer: {
        ssr: {
          include: ['@cloudflare/containers'],
        },
      },
    },
  },
});
