import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/postgres.test.ts', 'test/capacity.test.ts'],
    fileParallelism: false,
  },
});
