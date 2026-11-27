import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Load the CommonJS builds of `pg-protocol`, `pg-pool` and `pg-cloudflare`, which the OAuth
 * endpoints, the feed backfill and the login rotation reach through `pg`.
 *
 * - `pg-protocol` and `pg-pool`: their ESM entry points are `.js` files in packages without
 *   `"type": "module"`, which the Workers pool parses as CommonJS (as in services/session-sync).
 * - `pg-cloudflare`: `pg` requires it when it opens a socket. The pool resolves that require to the
 *   package's `workerd` import entry, an ES module without a default export, and a CommonJS require
 *   of it gives `undefined`, so no `pg` client could connect. The package's `exports` hides its
 *   CommonJS build, so the path comes from the package directory.
 */
function fixPgCjsDependencies() {
  return {
    name: 'fix-pg-cjs-dependencies',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (importer === undefined) return undefined;
      if (source === 'pg-protocol') {
        return createRequire(importer).resolve('pg-protocol/dist/index.js');
      }
      if (source === 'pg-pool') return createRequire(importer).resolve(source);
      if (source === 'pg-cloudflare') {
        const manifest = createRequire(importer).resolve('pg-cloudflare/package.json');
        return join(dirname(manifest), 'dist/index.js');
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [
    fixPgCjsDependencies(),
    cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } }),
  ],
  test: {
    include: ['test/unit/**/*.test.ts', 'test/runtime/**/*.test.ts'],
    testTimeout: 20_000,
    // Console calls write to the runtime's output instead of going to vitest as worker RPC calls.
    // A console call inside a Durable Object is sent on that object's behalf; when a test aborts
    // the object (`state.abort`) before the send lands, the send is cancelled and the call never
    // gets an answer. Vitest waits for every pending call, with no timeout, before it ends a test
    // file, so the run would hang there while the object's alarm keeps running.
    disableConsoleIntercept: true,
  },
});
