import { drizzle } from 'drizzle-orm/node-postgres';
import pg, { types } from 'pg';
import * as schema from './schema';
import { getDatabaseClientConfig } from './database-url';

// Drizzle requires this for BigInts
// https://orm.drizzle.team/docs/column-types/pg#bigint
types.setTypeParser(types.builtins.INT8, val => BigInt(val));

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
    ...poolConfig,
  });

  const db = drizzle(pool, { schema, logger });

  return { db, pool, schema };
}

/**
 * Convenience wrapper for Cloudflare Workers using Hyperdrive.
 * Hyperdrive handles connection pooling at the infrastructure level,
 * so we use max: 1 here. Pass env.HYPERDRIVE.connectionString directly.
 */
export function getWorkerDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  return drizzle(pool, { schema });
}

export type WorkerDb = ReturnType<typeof getWorkerDb>;

export { pg };
