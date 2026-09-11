import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

// Mirrors the wrangler.jsonc Text rule for `**/*.sql`: drizzle/migrations.js
// imports migration SQL as modules. `vitest related` analyzes every test file's
// import graph regardless of vi.mock factories, so without this loader the
// .sql files fail to parse as JavaScript and the command exits 1.
const sqlAsText: Plugin = {
  name: 'wrangler-sql-as-text',
  enforce: 'pre',
  load(id) {
    const file = id.split('?')[0];
    if (!file.endsWith('.sql')) return null;
    return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
  },
};

// Unit tests - run in Node (fast, supports vi.mock and global mocking)
export default defineConfig({
  plugins: [sqlAsText],
  test: {
    name: 'unit',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'test/unit/**/*.test.ts'],
    exclude: ['test/integration/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts'],
    },
    server: {
      deps: {
        external: ['@cloudflare/sandbox', '@cloudflare/containers'],
      },
    },
  },
});
