import { Kysely, PostgresDialect, type Generated, type ColumnType } from 'kysely';
import { pg } from '@kilocode/db/client';

export type HyperdriveBinding = {
  connectionString: string;
};

// Default node-postgres behavior is to use strings for bigints. Parse as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (val: string) => parseInt(val, 10));

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
  git_url: Generated<string | null>;
  git_branch: Generated<string | null>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
};

export type KilocodeUsersTable = {
  id: string;
};

export type Database = {
  cli_sessions_v2: CliSessionsV2Table;
  kilocode_users: KilocodeUsersTable;
};

/**
 * Hyperdrive pools connections at the infrastructure level,
 * so we use max:1 to avoid holding extra connections open.
 */
export function getDb(hyperdrive: HyperdriveBinding): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: hyperdrive.connectionString,
    max: 1,
  });

  pool.on('error', (error: Error) => {
    console.error('pg Pool error', error);
  });

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  return db;
}
