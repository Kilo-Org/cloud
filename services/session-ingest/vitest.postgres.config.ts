import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'postgres',
    environment: 'node',
    include: ['test/postgres/**/*.test.ts'],
  },
});
