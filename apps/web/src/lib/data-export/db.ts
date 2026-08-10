import { getEnvVariable } from '@/lib/dotenvx';
import { getDatabaseClientConfig } from '@kilocode/db';
import { pg } from '@kilocode/db/client';
import { drizzle } from 'drizzle-orm/node-postgres';
import { attachDatabasePool } from '@vercel/functions';

/**
 * Client for the data export database: a separate, read-only Postgres instance
 * loaded out of band to back the user data export feature.
 *
 * Export manifests perform bulk scans of large tables. Today those reads go to
 * the primary's replica (`readDb`, guarded by replica-routing.test.ts); pointing
 * them here moves that load off the read-write database entirely.
 *
 * Three things make this deliberately different from `@/lib/drizzle`:
 *
 * 1. It is lazy. The primary pool is created at import time because the app
 *    cannot serve a single request without it. This database is optional, so
 *    nothing connects until an export query actually runs. `DATA_EXPORT_POSTGRES_URL`
 *    has no tracked dotenv default, so external contributors run without it.
 *
 * 2. Pool errors log and continue. `drizzle.ts` calls `process.exit(-1)` on an
 *    idle client error, which is right for the primary and wrong here: the local
 *    development value may point at a database that has not been loaded yet, and
 *    an unreachable export database must never take down the web server.
 *
 * 3. The schema is owned and loaded out of band by a separate process. No table
 *    definitions live in `packages/db/src/schema.ts`, so drizzle-kit can never
 *    generate a migration against a database this repository does not own.
 */

const DATA_EXPORT_POSTGRES_URL = getEnvVariable('DATA_EXPORT_POSTGRES_URL');

/**
 * Export reads are few and slow rather than many and fast, so this pool stays
 * small. The primary already contends for Supabase's connection limit across
 * ~2,200 concurrent Vercel instances; this must not add to it.
 */
const max = 3;

const idleTimeoutMillis = 5_000;

export type DataExportDb = ReturnType<typeof drizzle>;

let cached: { db: DataExportDb; pool: pg.Pool } | null = null;

/**
 * Whether the export database is configured in this environment. Call before
 * `getDataExportDb()` to skip the feature rather than surface an error.
 */
export function isDataExportDbConfigured(): boolean {
  return !!DATA_EXPORT_POSTGRES_URL;
}

/**
 * Returns the export database client, creating the pool on first use.
 *
 * Throws when the variable is unset. Callers that can degrade gracefully should
 * gate on `isDataExportDbConfigured()` first.
 */
export function getDataExportDb(): DataExportDb {
  return getDataExportClient().db;
}

function getDataExportClient(): { db: DataExportDb; pool: pg.Pool } {
  if (cached) return cached;

  if (!DATA_EXPORT_POSTGRES_URL) {
    throw new Error(
      'DATA_EXPORT_POSTGRES_URL not configured. Gate export reads on isDataExportDbConfigured().'
    );
  }

  const pool = new pg.Pool({
    ...getDatabaseClientConfig(DATA_EXPORT_POSTGRES_URL),
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis: Number.parseInt(process.env.POSTGRES_CONNECT_TIMEOUT || '30000'),
    // Supavisor rejects statement_timeout in the startup packet, so query timeouts
    // are enforced client side instead. See lib/replication-health.ts for the same
    // constraint on the primary's replicas.
    query_timeout: Number.parseInt(process.env.POSTGRES_MAX_QUERY_TIME || '20000'),
    application_name: 'kilocode-web-data-export',
  });

  // Log and continue: an unreachable export database degrades one feature, unlike
  // the primary, where a dead pool means the process cannot serve traffic.
  pool.on('error', (err: Error) => {
    console.error('Unexpected error on idle client (data export)', err);
  });

  // Close idle connections before the function suspends. Skipped in tests, where
  // it interferes with Jest cleanup (same carve-out as lib/drizzle.ts).
  if (process.env.NODE_ENV !== 'test') {
    attachDatabasePool(pool);
  }

  cached = { db: drizzle(pool), pool };
  return cached;
}

/** Closes the export database pool. For test teardown and script shutdown. */
export async function closeDataExportDbConnection(): Promise<void> {
  if (!cached) return;
  const { pool } = cached;
  cached = null;
  await pool.end();
}
