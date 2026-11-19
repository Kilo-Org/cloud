import { drizzle } from 'drizzle-orm/node-postgres';
import pg, { types } from 'pg';
import * as schema from './schema';
import { getDatabaseClientConfig } from './database-url';

/**
 * Per-pool parsers that hand back `int8` (OID 20) as a `BigInt`.
 *
 * Drizzle's `bigint` columns read either form, but raw results here and in the export
 * paths expect a `BigInt` (https://orm.drizzle.team/docs/column-types/pg#bigint). Opt in
 * by passing this to a pool's `types`; `pg.types.setTypeParser` would instead change
 * decoding for every client in the process, including clients that never imported this
 * module. Other OIDs and the binary format keep pg's own parsers.
 */
export const databaseTypeParsers: pg.CustomTypesConfig = {
  getTypeParser: (oid, format): ((value: string) => unknown) => {
    if (oid === types.builtins.INT8 && (format ?? 'text') === 'text') {
      return (value: string) => BigInt(value);
    }
    // pg types every parser as `(value: string) => any`; callers only invoke the result.
    return types.getTypeParser(oid, format) as (value: string) => unknown;
  },
};

export type CreateDrizzleClientOptions = {
  connectionString: string;
  /**
   * Pool settings this client does not derive itself. `types` is left out of the type because the
   * pool is created with the module's `databaseTypeParsers`, which raw results and the export paths
   * expect. Like `GetWorkerDbOptions`, this is a type-level reservation.
   */
  poolConfig?: Omit<Partial<pg.PoolConfig>, 'types'>;
  logger?: boolean;
  /**
   * Replaces the TLS settings that `getDatabaseClientConfig` derives from the connection string
   * and `DATABASE_CA`. The override is intentional: local and test PostgreSQL servers are often
   * plaintext, and `DATABASE_CA` in the environment would otherwise force TLS on them.
   */
  ssl?: { ca: string } | false;
};

export type DrizzleClient = ReturnType<typeof createDrizzleClient>;

export function createDrizzleClient(options: CreateDrizzleClientOptions) {
  const { connectionString, poolConfig = {}, logger = false, ssl } = options;

  const baseConfig = getDatabaseClientConfig(connectionString);
  if (ssl !== undefined) {
    baseConfig.ssl = ssl;
  }

  const pool = new pg.Pool({
    ...baseConfig,
    types: databaseTypeParsers,
    ...poolConfig,
  });

  const db = drizzle(pool, { schema, logger });

  return { db, pool, schema };
}

/**
 * Bounds for every transaction that a Worker DB client starts. Hyperdrive pools in transaction
 * mode and resets `SET` state when it returns a connection to its pool, and it does not apply
 * settings sent at connection startup. So the bounds are `SET LOCAL`
 * statements in the same message as `BEGIN`, and a Worker that stops right after `BEGIN` still
 * leaves a transaction that PostgreSQL ends. `lock_timeout` bounds row-lock waits such as
 * `FOR UPDATE`. The idle bound stays above the longest awaited non-database step inside a Worker
 * transaction: two consecutive 10 s GitHub requests in the git-token-service disconnect flow.
 */
export const workerTransactionBoundsSql =
  "SET LOCAL lock_timeout = '10s'; SET LOCAL idle_in_transaction_session_timeout = '30s'";

const transactionStart = /^begin\b/i;

function isTextQueryConfig(config: unknown): config is pg.QueryConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    'text' in config &&
    typeof config.text === 'string' &&
    !('submit' in config)
  );
}

function withTransactionBounds(config: unknown): unknown {
  if (typeof config === 'string') {
    return transactionStart.test(config) ? `${config}; ${workerTransactionBoundsSql}` : config;
  }
  if (isTextQueryConfig(config) && transactionStart.test(config.text)) {
    return { ...config, text: `${config.text}; ${workerTransactionBoundsSql}` };
  }
  return config;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise;
}

/**
 * drizzle sends `BEGIN` before the `try` block that releases the connection, so a failed `BEGIN`
 * leaves the pool's only connection checked out and every later query on the client waits for
 * it. The forwarder releases the connection with the error, and the pool closes it.
 */
function boundTransactionStarts(client: pg.PoolClient): void {
  // pg types `query` as overloads. This forwarder changes only the text of a transaction start.
  const query = client.query.bind(client) as (config: unknown, ...rest: unknown[]) => unknown;
  client.query = ((config: unknown, ...rest: unknown[]) => {
    const boundedConfig = withTransactionBounds(config);
    const result = query(boundedConfig, ...rest);
    if (boundedConfig === config || !isPromise(result)) return result;
    return result.catch((error: unknown) => {
      client.release(error instanceof Error ? error : true);
      throw error;
    });
  }) as typeof client.query;
}

/**
 * pg emits `error` on a checked-out connection that fails between statements, for example when
 * PostgreSQL ends an idle transaction. pg still rejects the queries that use the failed
 * connection. The Workers socket also emits `error` when the pool closes a released connection,
 * and pg-pool forwards errors of released connections to the pool. Without listeners each of
 * these events is an uncaught exception. Only the failure of a checked-out connection is reported.
 */
function reportConnectionErrors(pool: pg.Pool): void {
  const released = new WeakSet<pg.PoolClient>();
  pool.on('release', (_error, client) => released.add(client));
  pool.on('connect', client => {
    client.on('error', error => {
      if (released.has(client)) return;
      console.warn('Worker database connection failed', { error: error.message });
    });
  });
  pool.on('error', () => undefined);
}

/**
 * Settings `getWorkerDb` fixes for every pool it creates: the connection string, `max: 1` because
 * Hyperdrive owns pooling, `maxUses: 1` so a released connection closes at once instead of
 * staying open for the pool's idle timeout, which in a Durable Object can outlive the request,
 * and `types` because the pool is created with the module's int8 parser. The transaction bounds in `workerTransactionBoundsSql` replace the startup settings for
 * lock and idle-in-transaction timeouts. The type reserves all of these, and `getWorkerDb` applies
 * its values after the caller's options.
 */
export type GetWorkerDbOptions = Omit<
  pg.PoolConfig,
  | 'connectionString'
  | 'max'
  | 'maxUses'
  | 'types'
  | 'lock_timeout'
  | 'idle_in_transaction_session_timeout'
>;

/**
 * Default bound on the wait for the pool's only connection, including connection setup. It
 * matches Hyperdrive's initial connection timeout. Without it a query that waits behind a
 * connection that is never released waits forever. Callers can set a shorter bound.
 */
const workerConnectionTimeoutMillis = 15_000;

/**
 * Convenience wrapper for Cloudflare Workers using Hyperdrive.
 * Hyperdrive handles connection pooling at the infrastructure level,
 * so we use max: 1 here. Pass env.HYPERDRIVE.connectionString directly.
 * Return a fresh wrapper per call so request/DO-bound I/O state never crosses contexts.
 * Each query or transaction uses its own connection, which closes when the pool releases it.
 */
export function getWorkerDb(connectionString: string, options: GetWorkerDbOptions = {}) {
  const pool = new pg.Pool({
    connectionTimeoutMillis: workerConnectionTimeoutMillis,
    ...options,
    connectionString,
    max: 1,
    maxUses: 1,
    types: databaseTypeParsers,
  });
  pool.on('connect', boundTransactionStarts);
  reportConnectionErrors(pool);
  return drizzle(pool, { schema });
}

export type WorkerDb = ReturnType<typeof getWorkerDb>;

export { pg };
