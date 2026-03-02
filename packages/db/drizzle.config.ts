import dotenv from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { computeDatabaseUrl, getDatabaseClientConfig } from './src/database-url';

dotenv.config({ path: '../../.env.local', quiet: true });

export default defineConfig({
  schema: './src/schema.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  // Feels nasty to use `as` here but the type of dbCredentials is not compatible with the one from pg
  dbCredentials: getDatabaseClientConfig(computeDatabaseUrl()) as {
    user: string;
    password: string;
    host: string;
    port: number;
    database: string;
  },
  verbose: !!process.env.DEBUG_QUERY_LOGGING,
  strict: true,
});
