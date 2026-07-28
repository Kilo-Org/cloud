import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['./vitest.pure.config.ts', './vitest.mounted.config.ts'],
  },
});
