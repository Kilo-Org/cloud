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
    // Mounted suites pay the same loaded-machine import cost as `mobile-pure`
    // when the gate runs them beside Metro, the simulator, and the local
    // services; keep one budget for both projects (see vitest.pure.config.ts).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['src/**/*.mounted.test.tsx'],
  },
});
