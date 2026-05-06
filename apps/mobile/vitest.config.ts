import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    name: 'mobile-onboarding',
    environment: 'node',
    include: [
      'src/lib/*.test.ts',
      'src/lib/onboarding/**/*.test.ts',
      'src/components/**/*.test.ts',
    ],
  },
});
