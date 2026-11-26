import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `pnpm test` runs the repo project, which needs no database.
    projects: [
      {
        test: {
          name: 'repo',
          environment: 'node',
          include: ['test/repo/**/*.test.ts'],
        },
      },
      {
        // `pnpm test:postgres`. Needs the identity-store Postgres: `pnpm db:up` (see README,
        // "Local database and tests").
        test: {
          name: 'db',
          environment: 'node',
          include: ['test/db/**/*.test.ts'],
          globalSetup: ['test/db/global-setup.ts'],
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
