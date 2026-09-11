import { defineConfig } from 'vitest/config';
import workersConfig from './vitest.workers.config';

// Kept separate from the SQLite-only suite: this requires migrated PostgreSQL.
if (!process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE) {
  throw new Error(
    'Set CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE to a migrated test database'
  );
}

export default defineConfig({
  ...workersConfig,
  test: {
    ...workersConfig.test,
    name: 'postgres',
    include: ['test/postgres/**/*.test.ts'],
  },
});
