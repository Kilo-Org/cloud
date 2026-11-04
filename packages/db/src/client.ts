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
  poolConfig?: Partial<pg.PoolConfig>;
  logger?: boolean;
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

export type GetWorkerDbOptions = Omit<pg.PoolConfig, 'connectionString' | 'max'>;

/**
 * Convenience wrapper for Cloudflare Workers using Hyperdrive.
 * Hyperdrive handles connection pooling at the infrastructure level,
 * so we use max: 1 here. Pass env.HYPERDRIVE.connectionString directly.
 * Return a fresh wrapper per call so request/DO-bound I/O state never crosses contexts.
 */
export function getWorkerDb(connectionString: string, options: GetWorkerDbOptions = {}) {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    types: databaseTypeParsers,
    ...options,
  });
  return drizzle(pool, { schema });
}

export type WorkerDb = ReturnType<typeof getWorkerDb>;

export { pg };
