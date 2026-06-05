import { defineConfig } from 'vitest/config';

export default defineConfig({
  assetsInclude: ['**/*.sql'],
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
