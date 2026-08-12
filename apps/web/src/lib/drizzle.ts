import { getEnvVariable } from '@/lib/dotenvx';
import { createDrizzleClient, pg } from '@kilocode/db/client';
import { computeDatabaseUrl } from '@kilocode/db';
import { sql as drizzleSql } from 'drizzle-orm';
import assert from 'node:assert';
import { attachDatabasePool } from '@vercel/functions';
export const { Client, Pool } = pg;
const {
  POSTGRES_CONNECT_TIMEOUT,
  POSTGRES_MAX_QUERY_TIME,
  DEBUG_QUERY_LOGGING,
  VERCEL_REGION,
  NODE_ENV,
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

const appName = IS_SCRIPT ? 'kilocode-script' : 'kilocode-web';

export function isUSRegion(region = VERCEL_REGION): boolean {
  if (!region) return false;
  return (
    region.startsWith('sfo') ||
    region.startsWith('iad') ||
    region.startsWith('pdx') ||
    region.startsWith('cle')
  );
}

export function selectReplicaUrl({
  primaryUrl,
  nodeEnv,
  vercelRegion,
  usReplicaUrl,
  euReplicaUrls,
  random = Math.random,
}: {
  primaryUrl: string;
  nodeEnv: string | undefined;
  vercelRegion: string | undefined;
  usReplicaUrl: string | undefined;
  euReplicaUrls: string[];
  random?: () => number;
}): string {
  if (nodeEnv === 'development') return primaryUrl;
  if (isUSRegion(vercelRegion)) return usReplicaUrl || primaryUrl;
  if (euReplicaUrls.length === 0) return primaryUrl;
  return euReplicaUrls.at(Math.floor(random() * euReplicaUrls.length)) ?? primaryUrl;
}

/**
 * Get the read replica URL based on deployment region.
 * - US deployments use the US replica (POSTGRES_REPLICA_US_URL) for lower latency
 * - EU deployments use POSTGRES_REPLICA_EU_URL. POSTGRES_REPLICA_EU_URL_2 is
 *   reserved for usage-analytics scans so those queries stay off this pool.
 * - Falls back to primary if no replica URL is configured for the region
 */
function getReplicaUrl(): string {
  if (NODE_ENV === 'development') return postgresUrl;
  const euReplicaUrl = getEnvVariable('POSTGRES_REPLICA_EU_URL');
  return selectReplicaUrl({
    primaryUrl: postgresUrl,
    nodeEnv: NODE_ENV,
    vercelRegion: VERCEL_REGION,
    usReplicaUrl: getEnvVariable('POSTGRES_REPLICA_US_URL'),
    euReplicaUrls: euReplicaUrl ? [euReplicaUrl] : [],
  });
}

/**
 * Replica used by /usage analytics. Always POSTGRES_REPLICA_EU_URL_2 in
 * production so heavy microdollar_usage scans do not compete with ordinary
 * readDb traffic. Falls back to the standard replica, then primary.
 */
export function selectUsageReplicaUrl({
  primaryUrl,
  nodeEnv,
  usageReplicaUrl,
  fallbackReplicaUrl,
}: {
  primaryUrl: string;
  nodeEnv: string | undefined;
  usageReplicaUrl: string | undefined;
  fallbackReplicaUrl: string;
}): string {
  if (nodeEnv === 'development') return primaryUrl;
  return usageReplicaUrl || fallbackReplicaUrl;
}

function getUsageReplicaUrl(): string {
  return selectUsageReplicaUrl({
    primaryUrl: postgresUrl,
    nodeEnv: NODE_ENV,
    usageReplicaUrl: getEnvVariable('POSTGRES_REPLICA_EU_URL_2'),
    fallbackReplicaUrl: getReplicaUrl(),
  });
}

// 48h of production pool metrics show most instances use 2-5 connections with zero
// waiting, but the aggregate across ~2,200 concurrent Vercel instances exhausts
// Supabase's ~500 connection limit (466 idle connections observed from kilocode-backend).
// Revisit after the microdollar_usage query performance work lands (see plans/db-perf-improvements.md).
const max = 10;

const idleTimeoutMillis = 5_000;

const sharedPoolConfig: Partial<pg.PoolConfig> = {
  max,
  connectionTimeoutMillis: Number.parseInt(POSTGRES_CONNECT_TIMEOUT || '30000'),
  idleTimeoutMillis,
};

// Primary pool - always points to Frankfurt (writes go here)
const primary = createDrizzleClient({
  connectionString: postgresUrl,
  poolConfig: { ...sharedPoolConfig, application_name: appName },
  logger: !!DEBUG_QUERY_LOGGING,
});
export const pool = primary.pool;

// Replica pool - points to US replica in US regions, primary in EU regions
const replicaUrl = getReplicaUrl();
export const usesSeparateReplica = replicaUrl !== postgresUrl;

const replica = usesSeparateReplica
  ? createDrizzleClient({
      connectionString: replicaUrl,
      poolConfig: { ...sharedPoolConfig, application_name: `${appName}-replica` },
      logger: !!DEBUG_QUERY_LOGGING,
    })
  : primary;
const replicaPool = replica.pool;

const usageReplicaUrl = getUsageReplicaUrl();
export const usesDedicatedUsageReplica =
  usageReplicaUrl !== postgresUrl && usageReplicaUrl !== replicaUrl;

const usageReplica = usesDedicatedUsageReplica
  ? createDrizzleClient({
      connectionString: usageReplicaUrl,
      poolConfig: {
        ...sharedPoolConfig,
        max: 2,
        application_name: `${appName}-usage-replica`,
      },
      logger: !!DEBUG_QUERY_LOGGING,
    })
  : usageReplicaUrl === replicaUrl
    ? replica
    : primary;
const usageReplicaPool = usageReplica.pool;

// Attach pools to ensure idle connections close before suspension
// Skip in test environment as it interferes with Jest's cleanup
if (process.env.NODE_ENV !== 'test') {
  attachDatabasePool(pool);
  if (usesSeparateReplica) {
    attachDatabasePool(replicaPool);
  }
  if (usesDedicatedUsageReplica) {
    attachDatabasePool(usageReplicaPool);
  }
}

// Pool error handlers: idle client errors trigger process exit in production
// because a failed connection pool means the process cannot serve traffic.
// In test mode, pool.end() during cleanup triggers idle client errors.
// Attach a non-exiting listener in test mode to prevent Node from throwing
// on an emitted error with zero listeners (same contract as replication-health.ts).
pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle client (primary)', err);
  if (process.env.NODE_ENV !== 'test') {
    process.exit(-1);
  }
});

if (usesSeparateReplica) {
  replicaPool.on('error', (err: Error) => {
    console.error('Unexpected error on idle client (replica)', err);
    if (process.env.NODE_ENV !== 'test') {
      process.exit(-1);
    }
  });
}

if (usesDedicatedUsageReplica) {
  usageReplicaPool.on('error', (err: Error) => {
    console.error('Unexpected error on idle client (usage-replica)', err);
    if (process.env.NODE_ENV !== 'test') {
      process.exit(-1);
    }
  });
}

// Pool observability is handled centrally by /api/cron/db-pool-metrics,
// which scrapes PgBouncer metrics from the Supabase Prometheus endpoint
// for all databases (primary + replicas) every minute.

/**
 * Primary database instance - use for all writes (INSERT, UPDATE, DELETE)
 * and for reads that require strong consistency (read-after-write).
 *
 * This always connects to the primary database in Frankfurt.
 */
const primaryDb = primary.db;

/**
 * Read replica database instance - use for read-only queries that can
 * tolerate slight replication lag (typically <100ms).
 *
 * In US regions, this connects to the US replica for lower latency.
 * In EU regions, this connects to the EU replica to split read traffic off the primary.
 * Falls back to the primary if no replica URL is configured for the region.
 */
export const readDb = replica.db;

/**
 * Read replica reserved for /usage analytics scans.
 * Points at POSTGRES_REPLICA_EU_URL_2 in production so those queries do not
 * share the standard readDb pool. Falls back to readDb, then primary.
 */
export const usageReadDb = usageReplica.db;

/**
 * Default database instance - connects to the primary database.
 * Use this for writes and for reads that need strong consistency.
 *
 * For read-heavy operations that can tolerate replication lag,
 * consider using `readDb` instead for better performance in US regions.
 */
export const db = primaryDb;
export { sql } from 'drizzle-orm';

// Helper for automatically updating the deleted_at column with database server time
export const auto_deleted_at = { deleted_at: drizzleSql`now()` };

// Test cleanup functions
// NOTE: With this simplified setup, the connection is created eagerly and not reset.
// Tests should not rely on closing and reopening the connection within the same process.

/**
 * Ends all pool connections. Error listeners stay attached because pg-pool
 * can emit idle-client errors after end() returns (client.end() runs async).
 * Removing listeners before those late emits causes unhandled exceptions.
 * An EventEmitter listener does not keep the event loop alive, so keeping
 * the listener does not block process exit.
 */
export async function closeAllDrizzleConnections(): Promise<void> {
  await pool.end();
  if (usesSeparateReplica) {
    await replicaPool.end();
  }
  if (usesDedicatedUsageReplica) {
    await usageReplicaPool.end();
  }
}

export type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function cleanupDbForTest(): Promise<void> {
  // Use primary for test cleanup to ensure consistency
  const { rows: tables } = await primaryDb.execute<{ tablename: string }>(
    drizzleSql`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename != 'migrations'
        AND NOT EXISTS (
          SELECT 1
          FROM pg_inherits
          JOIN pg_class child ON pg_inherits.inhrelid = child.oid
          JOIN pg_namespace child_ns ON child.relnamespace = child_ns.oid
          WHERE child_ns.nspname = 'public'
            AND child.relname = pg_tables.tablename
        )
      ORDER BY tablename
    `
  );

  if (tables.length === 0) return;

  const truncateTargets = tables.map(({ tablename }) => `"${tablename}"`).join(', ');
  await primaryDb.execute(
    drizzleSql.raw(`TRUNCATE TABLE ${truncateTargets} RESTART IDENTITY CASCADE;`)
  );
}
