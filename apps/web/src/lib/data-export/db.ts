import { getEnvVariable } from '@/lib/dotenvx';
import { getDatabaseClientConfig } from '@kilocode/db';
import { pg } from '@kilocode/db/client';
import { drizzle } from 'drizzle-orm/node-postgres';
import { attachDatabasePool } from '@vercel/functions';
import { z } from 'zod';

/**
 * Client for the data export database: a separate, read-only Postgres instance
 * loaded out of band to back the user data export feature.
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

/**
 * Export reads are bulk, keyset-paginated scans rather than interactive queries,
 * so this pool sets its own timeout instead of reusing `POSTGRES_MAX_QUERY_TIME`.
 * That variable is sized for the primary's request-path workload (5s under
 * `.env.test`) and is not applied to any pool in `drizzle.ts`.
 *
 * Enforced client side because Supavisor rejects `statement_timeout` in the
 * startup packet — the same constraint documented in lib/replication-health.ts.
 * Note that pg destroys the connection on timeout, so a value too low burns one
 * of the few pooled connections on every slow query.
 */
export const QUERY_TIMEOUT_MS = 60_000;

/**
 * Export reads are few and slow rather than many and fast, so this pool stays
 * small. The primary already contends for Supabase's connection limit across
 * ~2,200 concurrent Vercel instances; this must not add to it.
 */
export const MAX_POOL_CONNECTIONS = 3;

const IDLE_TIMEOUT_MS = 5_000;

const connectionUrlSchema = z
  .string()
  .min(1)
  .refine(
    value => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
          !!url.hostname &&
          Number.isInteger(Number(url.port)) &&
          Number(url.port) > 0
        );
      } catch {
        return false;
      }
    },
    { message: 'must be a postgres:// URL with a host and port' }
  );

export type DataExportUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'unset' | 'invalid' };

/**
 * Validates the connection string shape up front, so a typo disables the feature
 * loudly at startup rather than throwing from deep inside the first query.
 */
export function parseDataExportDatabaseUrl(raw: string | undefined): DataExportUrlResult {
  if (!raw) return { ok: false, reason: 'unset' };
  return connectionUrlSchema.safeParse(raw).success
    ? { ok: true, url: raw }
    : { ok: false, reason: 'invalid' };
}

const parsedUrl = parseDataExportDatabaseUrl(getEnvVariable('DATA_EXPORT_POSTGRES_URL'));

if (!parsedUrl.ok && parsedUrl.reason === 'invalid') {
  // Set but unusable is an operator error, not an opted-out environment. Say so
  // once at startup instead of failing at the first export request.
  console.error(
    'DATA_EXPORT_POSTGRES_URL is set but is not a valid postgres:// URL. Data export reads are disabled.'
  );
}

// WHATWG URL keeps the brackets on an IPv6 literal, so `new URL(...).hostname`
// yields '[::1]'. The bare form is kept for callers passing a hostname directly.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The export database is a different host from the primary, so it does not
 * inherit the primary's `ssl: false` fallback. Anything non-local gets TLS: these
 * tables carry user-identifiable data, and a missing `DATABASE_CA` must surface
 * as a connection error rather than a silent plaintext connection.
 */
export function resolveSslConfig(hostname: string): pg.ConnectionConfig['ssl'] {
  if (LOCAL_HOSTNAMES.has(hostname)) return false;

  const ca = process.env.DATA_EXPORT_DATABASE_CA || process.env.DATABASE_CA;
  if (!ca) return { rejectUnauthorized: true };

  return {
    ca: ca.replace(/\\n/g, '\n'),
    rejectUnauthorized: true,
    servername: hostname,
  };
}

export type DataExportDb = ReturnType<typeof drizzle>;

let cached: { db: DataExportDb; pool: pg.Pool } | null = null;

/**
 * Whether the export database is configured and usable in this environment. Call
 * before `getDataExportDb()` to skip the feature rather than surface an error.
 */
export function isDataExportDbConfigured(): boolean {
  return parsedUrl.ok;
}

/**
 * Returns the export database client, creating the pool on first use.
 *
 * Throws when the variable is unset or malformed. Callers that can degrade
 * gracefully should gate on `isDataExportDbConfigured()` first.
 */
export function getDataExportDb(): DataExportDb {
  return getDataExportClient().db;
}

function getDataExportClient(): { db: DataExportDb; pool: pg.Pool } {
  if (cached) return cached;

  if (!parsedUrl.ok) {
    throw new Error(
      parsedUrl.reason === 'unset'
        ? 'DATA_EXPORT_POSTGRES_URL not configured. Gate export reads on isDataExportDbConfigured().'
        : 'DATA_EXPORT_POSTGRES_URL is set but is not a valid postgres:// URL.'
    );
  }

  const baseConfig = getDatabaseClientConfig(parsedUrl.url);

  const pool = new pg.Pool({
    ...baseConfig,
    ssl: resolveSslConfig(new URL(parsedUrl.url).hostname),
    max: MAX_POOL_CONNECTIONS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: Number.parseInt(process.env.POSTGRES_CONNECT_TIMEOUT || '30000'),
    query_timeout: QUERY_TIMEOUT_MS,
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
