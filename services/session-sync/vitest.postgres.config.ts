import { defineConfig } from 'vitest/config';

// The account database suite runs in Node against a migrated local PostgreSQL.
export default defineConfig({
  test: {
    name: 'postgres',
    environment: 'node',
    include: ['test/postgres/**/*.test.ts'],
  },
});
