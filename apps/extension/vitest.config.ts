import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('.', import.meta.url).pathname,
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
