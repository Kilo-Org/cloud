import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { logger } from '@anaconda/playwright-utils';
import { Pool, type QueryResultRow } from 'pg';

/** The database the app reads (root `.env.local`) unless `POSTGRES_URL` is set, as in CI. No guessed default. */
function databaseUrl(): string {
  if (process.env.POSTGRES_URL) {
    return process.env.POSTGRES_URL;
  }
  const envFile = resolve(__dirname, '../../../../.env.local');
  const fromEnvFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')).POSTGRES_URL : undefined;
  if (!fromEnvFile) {
    throw new Error(`POSTGRES_URL is not set and not found in ${envFile}`);
  }
  return fromEnvFile;
}

/**
 * Direct access to the E2E database for seeding. Plain SQL keeps this package
 * independent of the monorepo's Drizzle schema; column names mirror packages/db/src/schema.ts.
 */
const pool = new Pool({
  connectionString: databaseUrl(),
  max: 2,
  connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT ?? 30_000),
  allowExitOnIdle: true,
});
// Without a listener, an error on an idle client crashes the worker instead of failing a query.
pool.on('error', error => logger.error(`Unexpected error on an idle E2E database client: ${error.message}`));

export async function query<row extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<row[]> {
  const result = await pool.query<row>(sql, params);
  return result.rows;
}
