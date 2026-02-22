import { defineConfig } from 'vitest/config';

// Unit tests - run in Node (fast, supports vi.mock and global mocking)
export default defineConfig({
  test: {
    name: 'unit',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts', 'container/plugin/**/*.test.ts'],
    exclude: ['test/integration/**/*.test.ts', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts'],
    },
  },
});
