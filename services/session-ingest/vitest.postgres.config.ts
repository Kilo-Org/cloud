import { defineConfig } from 'vitest/config';

export default defineConfig({
  assetsInclude: ['**/*.sql'],
  test: {
    name: 'postgres',
    environment: 'node',
    include: ['test/postgres/**/*.test.ts'],
  },
});
