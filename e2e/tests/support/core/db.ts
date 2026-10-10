import { logger } from '@anaconda/playwright-utils';
import { Pool, type QueryResultRow } from 'pg';

/**
 * Direct access to the E2E database for seeding and state checks. Plain SQL keeps this package
 * independent of the monorepo's Drizzle schema; column names mirror packages/db/src/schema.ts.
 */
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
  max: 2,
  allowExitOnIdle: true,
});
// Without a listener, an error on an idle client crashes the worker instead of failing a query.
pool.on('error', error => logger.error(`Unexpected error on an idle E2E database client: ${error.message}`));

export async function query<row extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<row[]> {
  const result = await pool.query<row>(sql, params);
  return result.rows;
}
