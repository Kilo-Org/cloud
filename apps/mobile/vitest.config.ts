import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'mobile-onboarding',
    environment: 'node',
    include: ['src/lib/onboarding/**/*.test.ts'],
  },
});
