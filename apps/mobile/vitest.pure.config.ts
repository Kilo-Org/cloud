import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

import { inlineSqlPlugin } from './vitest.sql-plugin';

// Pure-logic tests: node environment, no React mounting. This is the original
// mobile vitest project, kept unchanged so the existing ~205 suites are
// unaffected by the mounted-test harness.
export default defineProject({
  plugins: [inlineSqlPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    name: 'mobile-pure',
    environment: 'node',
    // The mobile-app gate runs `vitest related` over the branch's changed files
    // (170+ suites) beside Metro, the simulator, and the local services. On that
    // loaded machine the first transform/import of a heavy dependency
    // (react-native-render-html, react-native-marked) can exceed the 5 s default
    // and fail a test that passes in isolation. The slow suite moves between
    // files from run to run, so the headroom belongs at the project level, not
    // in a single test file.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [
      'src/i18n/**/*.test.ts',
      'src/lib/*.test.ts',
      'src/lib/a11y/**/*.test.ts',
      'src/lib/agent-attachments/**/*.test.ts',
      'src/lib/analytics/**/*.test.ts',
      'src/lib/auth/**/*.test.ts',
      'src/lib/chat/**/*.test.ts',
      'src/lib/auth/**/*.test.tsx',
      'src/lib/apple-iap/**/*.test.ts',
      'src/lib/apple-iap/**/*.test.tsx',
      'src/lib/glanceable/**/*.test.ts',
      'src/lib/kiloclaw/**/*.test.ts',
      'src/glanceable-ios/**/*.test.ts',
      'src/glanceable-android/**/*.test.ts',
      'src/lib/hooks/**/*.test.ts',
      'src/lib/kilo-pass/**/*.test.ts',
      'src/lib/kilo-pass/**/*.test.tsx',
      'src/lib/navigation/**/*.test.ts',
      'src/lib/onboarding/**/*.test.ts',
      'src/lib/persist/**/*.test.ts',
      'src/lib/pr-review/**/*.test.ts',
      'src/lib/query/**/*.test.ts',
      'src/lib/voice-input/**/*.test.ts',
      'src/components/**/*.test.ts',
      'src/components/agents/**/!(*.mounted).test.tsx',
      'src/components/pr-review/**/!(*.mounted).test.tsx',
      // `!(*.mounted)` keeps `*.mounted.test.tsx` in the mounted project only:
      // this directory holds both kinds, and a file in both projects runs twice.
      'src/components/kiloclaw/**/!(*.mounted).test.tsx',
      'src/lib/telemetry/**/*.test.ts',
      'modules/kilo-surface-geometry/*.test.ts',
    ],
  },
});
