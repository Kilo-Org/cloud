import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'mobile-onboarding',
    environment: 'node',
    include: [
      'src/lib/*.test.ts',
      'src/lib/onboarding/**/*.test.ts',
      'src/lib/hooks/**/*.test.ts',
      'src/components/**/*.test.ts',
    ],
  },
});
