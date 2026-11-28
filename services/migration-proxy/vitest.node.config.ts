import { defineConfig } from 'vitest/config';

/** Repository and config checks that read files from disk, and the pure modules' unit tests. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/repo/**/*.test.ts', 'test/unit/**/*.test.ts'],
  },
});
