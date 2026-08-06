import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

// Pure-logic tests: node environment, no React mounting. This is the original
// mobile vitest project, kept unchanged so the existing ~205 suites are
// unaffected by the mounted-test harness.
export default defineProject({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    name: 'mobile-pure',
    environment: 'node',
    include: [
      'src/lib/*.test.ts',
      'src/lib/a11y/**/*.test.ts',
      'src/lib/agent-attachments/**/*.test.ts',
      'src/lib/analytics/**/*.test.ts',
      'src/lib/auth/**/*.test.ts',
      'src/lib/auth/**/*.test.tsx',
      'src/lib/apple-iap/**/*.test.ts',
      'src/lib/apple-iap/**/*.test.tsx',
      'src/lib/hooks/**/*.test.ts',
      'src/lib/kilo-pass/**/*.test.ts',
      'src/lib/kilo-pass/**/*.test.tsx',
      'src/lib/onboarding/**/*.test.ts',
      'src/lib/persist/**/*.test.ts',
      'src/lib/pr-review/**/*.test.ts',
      'src/lib/voice-input/**/*.test.ts',
      'src/components/**/*.test.ts',
      'src/components/pr-review/**/*.test.tsx',
      'src/components/kiloclaw/**/*.test.tsx',
      'src/components/login/**/*.test.tsx',
      'src/lib/telemetry/**/*.test.ts',
    ],
  },
});
