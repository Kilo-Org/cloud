import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['plugin/**/*.test.ts'],
  },
});
