import { defineConfig } from 'vitest/config';

// Postgres-backed tests. Run against a real database, not the Workers runtime:
// the query modules take a Drizzle client, so they are exercised directly.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/postgres.test.ts'],
    fileParallelism: false,
  },
});
