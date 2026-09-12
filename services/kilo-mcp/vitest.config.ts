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
