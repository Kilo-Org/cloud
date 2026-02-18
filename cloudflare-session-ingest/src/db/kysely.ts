import { Kysely, PostgresDialect, type Generated, type ColumnType } from 'kysely';
import { Pool, types } from 'pg';

export type HyperdriveBinding = {
  connectionString: string;
};

// Default node-postgres behavior is to use strings for bigints. Parse as numbers.
types.setTypeParser(types.builtins.INT8, val => parseInt(val, 10));

/**
 * Keep this in sync with the schema in `src/db/schema.ts` in the main repository.
 */
export type CliSessionsV2Table = {
  session_id: string;
  kilo_user_id: string;
  cloud_agent_session_id: Generated<string | null>;
  version: ColumnType<number, number | undefined, never>;
  public_id: Generated<string | null>;
  parent_session_id: Generated<string | null>;
  title: Generated<string | null>;
  created_on_platform: Generated<string | null>;
  organization_id: Generated<string | null>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
};

export type Database = {
  cli_sessions_v2: CliSessionsV2Table;
};

export function getDb(hyperdrive: HyperdriveBinding): Kysely<Database> {
  const pool = new Pool({
    connectionString: hyperdrive.connectionString,
    max: 5,
  });

  pool.on('error', error => {
    console.error('pg Pool error', error);
  });

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  return db;
}
