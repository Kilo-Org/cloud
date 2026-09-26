import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'postgres',
    globals: true,
    environment: 'node',
    include: ['test/postgres/**/*.test.ts'],
    setupFiles: ['test/postgres/setup.ts'],
    fileParallelism: false,
  },
});
