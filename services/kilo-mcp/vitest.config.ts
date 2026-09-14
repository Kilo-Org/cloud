import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * `cloudflare:workers` (DurableObject, WorkerEntrypoint) does not exist under
 * plain node vitest. The OAuth provider library and the store import it at
 * module load, so alias it to a stub — the same pattern as
 * services/auto-routing/vitest.config.ts.
 */
const cloudflareWorkersStub = new URL(
  './src/test-support/cloudflare-workers-stub.ts',
  import.meta.url
).pathname;

/** Serve `.sql` imports as raw text so tests run the real DO migrations. */
function rawSql(): Plugin {
  return {
    name: 'raw-sql',
    enforce: 'pre',
    load(id) {
      if (id.endsWith('.sql')) {
        return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [rawSql()],
  resolve: {
    alias: {
      'cloudflare:workers': cloudflareWorkersStub,
    },
  },
  test: {
    name: 'unit',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The provider is a node_modules ESM package that imports
    // `cloudflare:workers` at load; process it through Vite so the alias above
    // rewrites that specifier instead of handing it to Node's ESM loader.
    server: {
      deps: {
        inline: ['@cloudflare/workers-oauth-provider'],
      },
    },
    // Verbose lists every passing test by name and prints the analytics
    // module's decisive `[kilo-mcp] analytics ...` log lines. The default
    // reporter hides both, so the local-proof lines the worker emits could
    // not be captured as evidence (gr1 backend gate).
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts'],
    },
  },
});
