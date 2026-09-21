import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

import { inlineSqlPlugin } from './vitest.sql-plugin';

// Mounted tests: render a real React tree (providers + TanStack Query) with
// test-renderer, which is DOM-free, so a `node` environment is used (no
// jsdom). Files match `*.mounted.test.tsx` so they never run in the pure
// project.
export default defineProject({
  plugins: [inlineSqlPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('src', import.meta.url)),
    },
  },
  test: {
    name: 'mobile-mounted',
    environment: 'node',
    // The app build's config module cannot load in this project; the setup
    // file stubs the exports its importers read.
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.mounted.test.tsx'],
    // Project configs do not inherit the root test options, and this suite
    // runs both projects in parallel: on a loaded host (dev stack, simulator,
    // Appium) workers starve and real-timer mounted renders exceed the 5s
    // default. Bounded pollers still fail on their own budget, so this only
    // absorbs starvation.
    testTimeout: 15_000,
  },
});
