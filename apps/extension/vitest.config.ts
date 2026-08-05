import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '#imports': new URL('src/__stubs__/imports.ts', import.meta.url).pathname,
      '@': new URL('.', import.meta.url).pathname,
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'entrypoints/**/*.test.ts'],
  },
});
