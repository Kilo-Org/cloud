import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The repo project has no files until the Worker checks land beside these tests.
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'repo',
          environment: 'node',
          include: ['test/repo/**/*.test.ts'],
        },
      },
      {
        // Needs the local identity-store Postgres: `pnpm db:up` (see README, "Identity store").
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
