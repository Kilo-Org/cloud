import { defineConfig } from 'vitest/config';

// Unit tests - run in Node (fast, no Workers runtime needed)
export default defineConfig({
  test: {
    name: 'unit',
    globals: true,
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    exclude: ['test/integration/**/*.test.ts'],
  },
});
