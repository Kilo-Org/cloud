import { getEnvVariable } from '@/lib/dotenvx';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg, { types } from 'pg';
import assert from 'node:assert';
import * as schema from '../db/schema';
import { computeDatabaseUrl, getDatabaseClientConfig } from './database-url';
export const { Client, Pool } = pg;
import { attachDatabasePool } from '@vercel/functions';
const {
  POSTGRES_CONNECT_TIMEOUT,
  POSTGRES_MAX_QUERY_TIME,
  DEBUG_QUERY_LOGGING,
  VERCEL_REGION,
  VERCEL_ENV,
} = process.env;

const POSTGRES_URL = getEnvVariable('POSTGRES_URL');

// Environment validation
if (!POSTGRES_URL) throw new Error('POSTGRES_URL not configured');
if (!POSTGRES_CONNECT_TIMEOUT) throw new Error('POSTGRES_CONNECT_TIMEOUT not configured');
if (!POSTGRES_MAX_QUERY_TIME) throw new Error('POSTGRES_MAX_QUERY_TIME not configured');

// Base url + test worker suffix (shared) - includes env validation internally
let postgresUrl = computeDatabaseUrl();

const IS_SCRIPT = process.env.IS_SCRIPT === 'true';

if (IS_SCRIPT) {
  // For scripts, we use a different connection string to avoid conflicts with the main app
  // This allows us to run scripts without affecting the main database connection
  assert(getEnvVariable('POSTGRES_SCRIPT_URL'), 'POSTGRES_SCRIPT_URL must be set for scripts');
  postgresUrl = getEnvVariable('POSTGRES_SCRIPT_URL');
}

// Drizzle requires this for BigInts
// https://orm.drizzle.team/docs/column-types/pg#bigint
types.setTypeParser(types.builtins.INT8, val => BigInt(val));

const appName = IS_SCRIPT ? 'kilocode-script' : 'kilocode-backend';

export function isUSRegion(): boolean {
  if (!VERCEL_REGION) return false;
  return (
    VERCEL_REGION.startsWith('sfo') ||
    VERCEL_REGION.startsWith('iad') ||
    VERCEL_REGION.startsWith('pdx') ||
    VERCEL_REGION.startsWith('cle')
  );
}

/**
 * Get the read replica URL based on deployment region.
 * - US deployments use the US replica (San Francisco) for lower latency
 * - EU deployments use the primary (Frankfurt) for reads
 * - Falls back to primary if no replica URL is configured
 */
function getReplicaUrl(): string {
  const replicaUrl = getEnvVariable('POSTGRES_REPLICA_US_URL');

  // If we're in a US region and have a replica configured, use it
  if (isUSRegion() && replicaUrl) {
    return replicaUrl;
  }

  // Otherwise, use the primary for reads (EU region or no replica configured)
  return postgresUrl;
}

// Keep low because Vercel can spawn 100+ concurrent serverless instances,
// each with its own pool, all hitting the same pgbouncer. At max:100, a cold-start
// cascade can open 100×N connections simultaneously and overwhelm pgbouncer.
const max = 10;

const idleTimeoutMillis = 10_000;

// Primary pool - always points to Frankfurt (writes go here)
export const pool = new Pool({
  ...getDatabaseClientConfig(postgresUrl),
  max,
  connectionTimeoutMillis: Number.parseInt(POSTGRES_CONNECT_TIMEOUT || '30000'),
  idleTimeoutMillis,
  application_name: appName,
});

// Replica pool - points to US replica in US regions, primary in EU regions
const replicaUrl = getReplicaUrl();
export const usesSeparateReplica = replicaUrl !== postgresUrl;

const replicaPool = usesSeparateReplica
  ? new Pool({
      ...getDatabaseClientConfig(replicaUrl),
      max,
      connectionTimeoutMillis: Number.parseInt(POSTGRES_CONNECT_TIMEOUT || '30000'),
      idleTimeoutMillis,
      application_name: `${appName}-replica`,
    })
  : pool; // Reuse primary pool if no separate replica

// Attach pools to ensure idle connections close before suspension
// Skip in test environment as it interferes with Jest's cleanup
if (process.env.NODE_ENV !== 'test') {
  attachDatabasePool(pool);
  if (usesSeparateReplica) {
    attachDatabasePool(replicaPool);
  }
}

pool.on('error', err => {
  console.error('Unexpected error on idle client (primary)', err);
  process.exit(-1);
});

if (usesSeparateReplica) {
  replicaPool.on('error', err => {
    console.error('Unexpected error on idle client (replica)', err);
    process.exit(-1);
  });
}

// --- Pool observability ---
// Periodic pool metrics (every 30s) — picked up by Vercel log drain → Axiom.
// instanceId lets us deduplicate readings per instance in Axiom queries.
const instanceId = `${VERCEL_REGION ?? 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Pool lifecycle events — low-volume, high-signal logs for connection churn.
// `connect` = new TCP connection to Postgres created
// `remove`  = connection destroyed (idle timeout, error, pool shutdown)
function attachPoolLifecycleLogging(targetPool: pg.Pool, label: 'primary' | 'replica') {
  targetPool.on('connect', () => {
    console.log(
      JSON.stringify({
        type: 'pool_lifecycle',
        event: 'connect',
        pool: label,
        instanceId,
        region: VERCEL_REGION ?? 'unknown',
        total: targetPool.totalCount,
        idle: targetPool.idleCount,
        waiting: targetPool.waitingCount,
      })
    );
  });

  targetPool.on('remove', () => {
    console.log(
      JSON.stringify({
        type: 'pool_lifecycle',
        event: 'remove',
        pool: label,
        instanceId,
        region: VERCEL_REGION ?? 'unknown',
        total: targetPool.totalCount,
        idle: targetPool.idleCount,
        waiting: targetPool.waitingCount,
      })
    );
  });
}

const IS_PROD = VERCEL_ENV === 'production';

if (IS_PROD) {
  attachPoolLifecycleLogging(pool, 'primary');
  if (usesSeparateReplica) {
    attachPoolLifecycleLogging(replicaPool, 'replica');
  }
}

function logPoolMetrics() {
  const primary = {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: pool.options.max,
  };
  const replica = usesSeparateReplica
    ? {
        total: replicaPool.totalCount,
        idle: replicaPool.idleCount,
        waiting: replicaPool.waitingCount,
        max: replicaPool.options.max,
      }
    : null;
  console.log(
    JSON.stringify({
      type: 'pool_metrics',
      instanceId,
      region: VERCEL_REGION ?? 'unknown',
      primary,
      replica,
    })
  );
}

if (IS_PROD) {
  logPoolMetrics();
  setInterval(logPoolMetrics, 30_000).unref();
}

/**
 * Primary database instance - use for all writes (INSERT, UPDATE, DELETE)
 * and for reads that require strong consistency (read-after-write).
 *
 * This always connects to the primary database in Frankfurt.
 */
const primaryDb = drizzle(pool, { schema, logger: !!DEBUG_QUERY_LOGGING });

/**
 * Read replica database instance - use for read-only queries that can
 * tolerate slight replication lag (typically <100ms).
 *
 * In US regions, this connects to the San Francisco replica for lower latency.
 * In EU regions, this connects to the primary (Frankfurt).
 *
 * Example usage:
 * ```
 * // Read from replica (fast for US users)
 * const users = await readDb.select().from(kilocode_users);
 *
 * // Write to primary
 * await db.insert(kilocode_users).values({ ... });
 *
 * // Read-after-write: use primary for consistency
 * await db.insert(kilocode_users).values({ ... });
 * const newUser = await db.select().from(kilocode_users).where(...);
 * ```
 */
export const readDb = drizzle(replicaPool, { schema, logger: !!DEBUG_QUERY_LOGGING });

/**
 * Default database instance - connects to the primary database.
 * Use this for writes and for reads that need strong consistency.
 *
 * For read-heavy operations that can tolerate replication lag,
 * consider using `readDb` instead for better performance in US regions.
 */
export const db = primaryDb;
export { sql };

// Helper for automatically updating the deleted_at column with database server time
export const auto_deleted_at = { deleted_at: sql`now()` };

// Test cleanup functions
// NOTE: With this simplified setup, the connection is created eagerly and not reset.
// Tests should not rely on closing and reopening the connection within the same process.

export async function closeAllDrizzleConnections(): Promise<void> {
  await pool.end();
  if (usesSeparateReplica) {
    await replicaPool.end();
  }
}

export type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function cleanupDbForTest(): Promise<void> {
  // Use primary for test cleanup to ensure consistency
  const { rows: tables } = await primaryDb.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' and tablename != 'migrations'`
  );

  const truncates = tables
    .map(({ tablename }) => `TRUNCATE TABLE "${tablename}" RESTART IDENTITY CASCADE;\n`)
    .join('');
  await primaryDb.execute(sql.raw(truncates));
}
