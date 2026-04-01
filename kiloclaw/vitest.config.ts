import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Treat .sql imports as raw text (needed for drizzle-orm/durable-sqlite migrations)
  assetsInclude: ['**/*.sql'],
  test: {
    name: 'unit',
    globals: true,
    environment: 'node',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'controller/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts'],
    },
    server: {
      deps: {
        external: [],
      },
    },
  },
});
