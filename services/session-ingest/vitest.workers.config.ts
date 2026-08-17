import { createRequire } from 'node:module';

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Redirect `pg-protocol` to its CommonJS build. Its package exports map points
 * `import` at `esm/index.js`, a `.js` file with ESM syntax in a package that
 * lacks `"type": "module"`. The Workers pool parses it as CommonJS and throws
 * "Cannot use import statement outside a module" when `pg` requires it.
 */
function fixPgProtocolCjs() {
  return {
    name: 'fix-pg-protocol-cjs',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (source !== 'pg-protocol' || importer === undefined) return undefined;
      // Resolve from the requiring file so the pnpm virtual store is found.
      return createRequire(importer).resolve('pg-protocol/dist/index.js');
    },
  };
}

// Integration tests - run in Cloudflare Workers runtime via Miniflare
export default defineConfig({
  plugins: [
    fixPgProtocolCjs(),
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.test.jsonc',
      },
    }),
  ],
  test: {
    name: 'integration',
    globals: true,
    include: ['test/integration/**/*.test.ts'],
  },
});
