import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/repo/**/*.test.ts', 'test/runtime/**/*.test.ts', 'test/proof/**/*.test.ts'],
  },
});
