import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
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
 * - EU deployments randomly select one of two EU replicas to split read traffic
 *   across ~2,200 concurrent Vercel instances (~50/50 statistical distribution)
 * - Falls back to primary if no replica URL is configured for the region
 */
function getReplicaUrl(): string {
  return selectReplicaUrl({
    primaryUrl: postgresUrl,
    nodeEnv: NODE_ENV,
    vercelRegion: VERCEL_REGION,
    usReplicaUrl: getEnvVariable('POSTGRES_REPLICA_US_URL'),
    euReplicaUrls: [
      getEnvVariable('POSTGRES_REPLICA_EU_URL'),
      getEnvVariable('POSTGRES_REPLICA_EU_URL_2'),
    ].filter(Boolean),
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

// Primary pool - writes go here; script runs (IS_SCRIPT) connect to POSTGRES_SCRIPT_URL
const primary = createDrizzleClient({
  connectionString: postgresUrl,
  poolConfig: { ...sharedPoolConfig, application_name: appName },
  logger: !!DEBUG_QUERY_LOGGING,
});
export const pool = primary.pool;

// Replica pool - US replica in US regions; in EU regions the configured EU
// replica, with the primary only as fallback
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

// Attach pools to ensure idle connections close before suspension
// Skip in test environment as it interferes with Jest's cleanup
if (process.env.NODE_ENV !== 'test') {
  attachDatabasePool(pool);
  if (usesSeparateReplica) {
    attachDatabasePool(replicaPool);
  }
}

/**
 * Whether an idle-client pool error should terminate the process. Pure and
 * exported so it can be unit-tested without a database, like `selectReplicaUrl`
 * above and `classifyReplicaRow` in replication-health.ts.
 *
 * A dead *primary* pool means the process cannot serve traffic, so it exits and
 * lets the platform replace the instance.
 *
 * A dead *replica* pool does not, so it only logs. The replica is a read-path
 * optimisation and `selectReplicaUrl` already treats a missing replica as "use
 * the primary". Exiting here escalated a replica-only outage into whole-instance
 * termination: when both EU replicas refused connections on 2026-08-12 this
 * handler fired 107 times in under an hour, killing instances whose primary was
 * healthy the entire time and taking writes and primary reads down with them.
 * Reads aimed at a broken replica now fail per-request instead.
 *
 * In test mode neither exits: `pool.end()` during cleanup emits idle-client
 * errors, and a listener must stay attached so Node does not treat the emit as
 * an unhandled throw.
 */
export function shouldExitOnPoolError(
  poolKind: 'primary' | 'replica',
  nodeEnv = process.env.NODE_ENV
): boolean {
  if (nodeEnv === 'test') return false;
  return poolKind === 'primary';
}

pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle client (primary)', err);
  if (shouldExitOnPoolError('primary')) {
    process.exit(-1);
  }
});

if (usesSeparateReplica) {
  replicaPool.on('error', (err: Error) => {
    console.error('Unexpected error on idle client (replica)', err);
    if (shouldExitOnPoolError('replica')) {
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
 * Connects to the primary connection string, or POSTGRES_SCRIPT_URL for script runs.
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
}

export type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Public tables that are not partitions; a partitioned root covers its partitions.
const cleanupRoots = drizzleSql`
  roots AS (
    SELECT c.oid, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname <> 'migrations'
      AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
  )
`;

/**
 * Leaves the database as `TRUNCATE <every public table> RESTART IDENTITY CASCADE`
 * would: every table and partition empty, every owned identity/serial sequence
 * restarted. Sequence restarts roll back with the deletes if cleanup fails.
 * TRUNCATE recreates the files of all ~250 tables and their indexes on every
 * call; this only deletes from tables whose heap has pages. A table without
 * pages holds no tuples, so the set never misses rows.
 * Like TRUNCATE RESTART IDENTITY, sequence restarts wait for transactions using
 * those sequences to finish. Each Jest worker has its own database.
 *
 * `session_replication_role = replica` skips FK checks and ON DELETE actions,
 * which is safe because every table holding rows is emptied in the same
 * transaction. It needs a superuser, as the test and dev Postgres roles are.
 */
export async function cleanupDbForTest(): Promise<void> {
  // Use primary for test cleanup to ensure consistency
  const emptied = await primaryDb.transaction(async tx => {
    const { rows: roots } = await tx.execute<{ name: string }>(drizzleSql`
      WITH ${cleanupRoots}
      SELECT format('%I', relname) AS name FROM roots ORDER BY relname
    `);
    if (roots.length === 0) return [];
    // Blocks writers on every table until commit, as TRUNCATE's lock did, so the
    // set below cannot go stale. A fixed order keeps concurrent cleanups from
    // deadlocking.
    await tx.execute(
      drizzleSql.raw(
        `LOCK TABLE ${roots.map(root => root.name).join(', ')} IN SHARE ROW EXCLUSIVE MODE`
      )
    );

    const { rows } = await tx.execute<{ kind: 'table' | 'sequence'; sql: string }>(drizzleSql`
      WITH RECURSIVE ${cleanupRoots},
      tree AS (
        SELECT oid AS root, oid AS rel FROM roots
        UNION ALL
        SELECT tree.root, i.inhrelid FROM tree JOIN pg_inherits i ON i.inhparent = tree.rel
      ),
      -- Materialized so pg_sequence_last_value only ever sees sequence OIDs.
      owned AS MATERIALIZED (
        SELECT s.seqrelid
        FROM tree
        JOIN pg_depend d
          ON d.refclassid = 'pg_class'::regclass
          AND d.refobjid = tree.rel
          AND d.classid = 'pg_class'::regclass
          AND d.deptype IN ('a', 'i')
        JOIN pg_sequence s ON s.seqrelid = d.objid
      )
      SELECT 'table' AS kind, format('%I', roots.relname) AS sql
      FROM roots
      JOIN tree ON tree.root = roots.oid
      GROUP BY roots.oid, roots.relname
      HAVING bool_or(pg_relation_size(tree.rel) > 0)
      UNION ALL
      SELECT 'sequence', format('ALTER SEQUENCE %s RESTART', seqrelid::regclass)
      FROM owned
      WHERE pg_sequence_last_value(seqrelid) IS NOT NULL
    `);
    const tables = rows.filter(row => row.kind === 'table').map(row => row.sql);
    const sequenceResets = rows.filter(row => row.kind === 'sequence').map(row => row.sql);

    const statements: string[] = [];
    if (tables.length > 0) {
      statements.push(
        'SET LOCAL session_replication_role = replica',
        ...tables.map(table => `DELETE FROM ${table}`)
      );
    }
    statements.push(...sequenceResets);
    if (statements.length > 0) await tx.execute(drizzleSql.raw(statements.join(';\n')));
    return tables;
  });

  // Shrinks the emptied heaps back to zero pages, as TRUNCATE leaves them, so the
  // next file inserts into a fresh heap and the next cleanup skips these tables.
  if (emptied.length > 0) await primaryDb.execute(drizzleSql.raw(`VACUUM ${emptied.join(', ')}`));
}
