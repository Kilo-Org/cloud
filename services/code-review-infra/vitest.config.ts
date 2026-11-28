import { defineConfig } from 'vitest/config';

/**
 * The node-environment unit suites in `src/` (the secret reader and its tests). The Workers-pool
 * integration suites in `test/integration/` run under `vitest.workers.config.ts`; the `test` script
 * runs both, so neither config collects the other's files.
 */
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
