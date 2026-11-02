import { defineConfig } from 'vitest/config';

// Unit tests - run in Node (fast, supports vi.mock and global mocking)
export default defineConfig({
  test: {
    name: 'unit',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
    exclude: ['test/integration/**/*.test.ts'],
  },
});
