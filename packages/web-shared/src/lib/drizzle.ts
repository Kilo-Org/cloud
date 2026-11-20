import { getEnvVariable, requireEnv } from '@kilocode/web-shared/lib/dotenvx';
import {
  KNOWN_READ_REPLICA_NAMES,
  readReplicaInventory,
} from '@kilocode/web-shared/lib/read-replicas';
import { createDrizzleClient, pg } from '@kilocode/db/client';
import { computeDatabaseUrl } from '@kilocode/db';
import { sql as drizzleSql } from 'drizzle-orm';
import { attachDatabasePool } from '@vercel/functions';
import { parseIPv6 } from '@kilocode/web-shared/lib/cloudflare-ip';
import { firstForwardedHop } from '@kilocode/web-shared/lib/http/forwarded-hop';
export const { Client, Pool } = pg;
const { DEBUG_QUERY_LOGGING, VERCEL_REGION, NODE_ENV } = process.env;

// Environment validation. A missing variable fails at module load through requireEnv, so every
// required-variable failure in this module has one throw type and one message shape.
const POSTGRES_CONNECT_TIMEOUT = requireEnv(
  'POSTGRES_CONNECT_TIMEOUT',
  process.env.POSTGRES_CONNECT_TIMEOUT
);

// Base url + test worker suffix (shared). It selects POSTGRES_URL_PRODUCTION or
// POSTGRES_URL for the current mode and throws when that variable is unset, so
// it owns the connection-URL contract; no pool below is built before it runs.
let postgresUrl = computeDatabaseUrl();

const IS_SCRIPT = process.env.IS_SCRIPT === 'true';

if (IS_SCRIPT) {
  // For scripts, we use a different connection string to avoid conflicts with the main app
  postgresUrl = requireEnv('POSTGRES_SCRIPT_URL', getEnvVariable('POSTGRES_SCRIPT_URL'));
}

const appName = IS_SCRIPT ? 'kilocode-script' : 'kilocode-web';

/**
 * Whether a region is on the US side. The root AGENTS.md section "Vercel Function Regions" is
 * the source of truth: functions run only in `fra1` and `sfo1`, and any other observed region is
 * a proxy or edge hop rather than the function, so only the SFO prefix can match.
 */
export function isUSRegion(region = VERCEL_REGION): boolean {
  if (!region) return false;
  return region.startsWith('sfo');
}

/**
 * The replica URLs `readDb` may read from, never empty. `readDb` picks one per request with
 * `selectReplicaIndex`; a single entry needs no choice.
 */
export function selectReplicaUrls({
  primaryUrl,
  nodeEnv,
  vercelRegion,
  usReplicaUrl,
  euReplicaUrls,
}: {
  primaryUrl: string;
  nodeEnv: string | undefined;
  vercelRegion: string | undefined;
  usReplicaUrl: string | undefined;
  euReplicaUrls: string[];
}): string[] {
  if (nodeEnv === 'development') return [primaryUrl];
  if (isUSRegion(vercelRegion)) return [usReplicaUrl || primaryUrl];
  if (euReplicaUrls.length === 0) return [primaryUrl];
  return euReplicaUrls;
}

/**
 * The part of a client address that picks its replica: the /64 prefix of an IPv6 address,
 * which privacy extensions keep while rotating the rest, otherwise the address itself.
 */
export function replicaAffinityKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const parsed = parseIPv6(ip);
  return parsed === null ? ip : (parsed >> BigInt(64)).toString(16);
}

/**
 * Which of `count` replicas serves a request. Replicas lag independently, so a user whose reads
 * alternate between them can see a row appear and then vanish. Hashing the client address sends
 * one address to the same replica from every instance; without an address, `fallbackIndex` (the
 * instance's own random pick) keeps at least each instance consistent.
 */
export function selectReplicaIndex(
  ip: string | null,
  count: number,
  fallbackIndex: number
): number {
  if (count <= 1) return 0;
  if (ip === null) return fallbackIndex;
  // FNV-1a: deterministic across instances, unlike Math.random.
  let hash = 0x811c9dc5;
  for (const char of replicaAffinityKey(ip)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  // FNV-1a's odd multiplier never changes the low bit, so `% 2` alone would only see the
  // parity of odd characters. The murmur3 finalizer mixes the high bits down.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) % count;
}

const SYMBOL_FOR_REQ_CONTEXT = Symbol.for('@vercel/request-context');

/**
 * The current request's headers from the Vercel request context, or undefined outside a request
 * and outside Vercel. `readDb` picks a replica synchronously and Next's `headers()` is async.
 * `@vercel/functions` reads the same symbol in `getContext`, which it does not export, as do
 * Vercel's firewall and flags packages.
 */
function vercelRequestHeaders(): Record<string, string> | undefined {
  const fromSymbol: typeof globalThis & {
    [SYMBOL_FOR_REQ_CONTEXT]?: { get?: () => { headers?: Record<string, string> } | undefined };
  } = globalThis;
  return fromSymbol[SYMBOL_FOR_REQ_CONTEXT]?.get?.()?.headers;
}

/**
 * The client address in request headers. Same headers, in the same order, as
 * `callerAddressOrNull` in `apps/web`.
 */
function requestIp(headers: Record<string, string>): string | null {
  return (
    firstForwardedHop(headers['x-vercel-forwarded-for']) ?? firstForwardedHop(headers['x-real-ip'])
  );
}

/**
 * Get the read replica URLs based on deployment region.
 * - US deployments use the US replica (POSTGRES_REPLICA_US_URL) for lower latency
 * - EU deployments use every enabled EU replica to split read traffic, picking one per request
 *   by client address
 * - Replicas listed in POSTGRES_REPLICAS_DISABLED are skipped (see read-replicas.ts)
 * - Falls back to primary if no enabled replica is configured for the region
 */
function getReplicaUrls(): string[] {
  const { enabled, unknownDisabled } = readReplicaInventory();
  if (unknownDisabled.length > 0) {
    console.warn(
      `POSTGRES_REPLICAS_DISABLED names unknown replicas: ${JSON.stringify(unknownDisabled)}; ` +
        `valid names: ${KNOWN_READ_REPLICA_NAMES.join(', ')}`
    );
  }
  return selectReplicaUrls({
    primaryUrl: postgresUrl,
    nodeEnv: NODE_ENV,
    vercelRegion: VERCEL_REGION,
    usReplicaUrl: enabled.find(replica => replica.side === 'us')?.url,
    euReplicaUrls: enabled.filter(replica => replica.side === 'eu').map(replica => replica.url),
  });
}

// 48h of production pool metrics show most instances use 2-5 connections with zero
// waiting, but the aggregate across ~2,200 concurrent Vercel instances exhausts
// Supabase's ~500 connection limit (466 idle connections observed from kilocode-backend).
// Revisit after the microdollar_usage query performance work lands.
const max = 10;

const idleTimeoutMillis = 5_000;

const sharedPoolConfig: Partial<pg.PoolConfig> = {
  max,
  connectionTimeoutMillis: Number.parseInt(POSTGRES_CONNECT_TIMEOUT),
  idleTimeoutMillis,
};

// Primary pool - writes go here; script runs (IS_SCRIPT) connect to POSTGRES_SCRIPT_URL
const primary = createDrizzleClient({
  connectionString: postgresUrl,
  poolConfig: { ...sharedPoolConfig, application_name: appName },
  logger: !!DEBUG_QUERY_LOGGING,
});
export const pool = primary.pool;

// Replica pools - US replica in US regions; in EU regions one pool per configured
// EU replica, with the primary only as fallback. Every EU instance now connects to
// both EU replicas instead of one, so each pool gets its share of `max`: an instance
// holds no more replica connections than before, and neither replica sees a higher ceiling.
const replicaUrls = getReplicaUrls();
export const usesSeparateReplica = replicaUrls[0] !== postgresUrl;
const replicaPoolMax = Math.ceil(max / replicaUrls.length);

const replicas = usesSeparateReplica
  ? replicaUrls.map(connectionString =>
      createDrizzleClient({
        connectionString,
        poolConfig: {
          ...sharedPoolConfig,
          max: replicaPoolMax,
          application_name: `${appName}-replica`,
        },
        logger: !!DEBUG_QUERY_LOGGING,
      })
    )
  : [primary];
const replicaPools = usesSeparateReplica ? replicas.map(replica => replica.pool) : [];

// Attach pools to ensure idle connections close before suspension
// Skip in test environment as it interferes with Jest's cleanup
if (process.env.NODE_ENV !== 'test') {
  attachDatabasePool(pool);
  for (const replicaPool of replicaPools) {
    attachDatabasePool(replicaPool);
  }
}

/**
 * Whether an idle-client pool error should terminate the process. Pure and
 * exported so it can be unit-tested without a database, like `selectReplicaUrls`
 * above and `classifyReplicaRow` in replication-health.ts.
 *
 * A dead *primary* pool means the process cannot serve traffic, so it exits and
 * lets the platform replace the instance.
 *
 * A dead *replica* pool does not, so its listener only logs and then calls this
 * predicate, which answers false. The replica is a read-path optimisation and
 * `selectReplicaUrls` already treats a missing replica as "use the primary".
 * Exiting here escalated a replica-only outage into whole-instance
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

for (const replicaPool of replicaPools) {
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
 * In EU regions, this splits read traffic off the primary across the EU replicas. Each query
 * builder, relational query, or transaction is bound when it is created to the replica
 * `selectReplicaIndex` picks for the current request.
 * Falls back to the primary if no replica URL is configured for the region.
 */
export const readDb = createReadDb(replicas.map(replica => replica.db));

export function createReadDb(dbs: DrizzleDatabase[]): DrizzleDatabase {
  const [first] = dbs;
  if (!first) throw new Error('readDb needs at least one database');
  if (dbs.length === 1) return first;
  const fallbackIndex = Math.floor(Math.random() * dbs.length);
  // Vercel keeps one headers object per request, so each request hashes its address once.
  const indexByHeaders = new WeakMap<object, number>();
  const currentDb = () => {
    const headers = vercelRequestHeaders();
    if (!headers) return dbs[fallbackIndex] ?? first;
    let index = indexByHeaders.get(headers);
    if (index === undefined) {
      index = selectReplicaIndex(requestIp(headers), dbs.length, fallbackIndex);
      indexByHeaders.set(headers, index);
    }
    return dbs[index] ?? first;
  };
  // One stable object, so callers that key on `readDb` (the model-stats cache) still see one client.
  return new Proxy(first, {
    get(_target, property) {
      const target = currentDb();
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return method.bind(target);
    },
  });
}

/**
 * Default database instance - connects to the primary database.
 * Use this for writes and for reads that need strong consistency.
 *
 * For read-heavy operations that can tolerate replication lag,
 * consider using `readDb` instead for better performance in US regions.
 */
export const db = primaryDb;

/**
 * A database connection: `db`, or `readDb` when a separate replica is configured. Both come from
 * the same client factory, so they share one type, and `DrizzleTransaction` is the narrower
 * connection a transaction hands to its callback.
 */
export type DrizzleDatabase = typeof db;

/**
 * The connection a helper accepts: the primary database, or a transaction when
 * the caller already holds one.
 */
export type DrizzleConnection = typeof db | DrizzleTransaction;

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
  for (const replicaPool of replicaPools) {
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
