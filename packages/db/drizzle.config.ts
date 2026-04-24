import dotenv from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { computeDatabaseUrl, getDatabaseClientConfig } from './src/database-url';

dotenv.config({ path: '../../.env.local', quiet: true });

export default defineConfig({
  schema: './src/schema.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  schemaFilter: ['public'],
  migrations: {
    table: '__drizzle_migrations',
    schema: 'drizzle',
  },
  dbCredentials: getDatabaseClientConfig(computeDatabaseUrl()),
  verbose: !!process.env.DEBUG_QUERY_LOGGING,
  strict: true,
});
