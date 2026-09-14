import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

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
  test: {
    name: 'unit',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts'],
    },
  },
});
