import { Pool, types } from 'pg';

// Default postgres behavior is to use strings for big ints. This parses them as regular numbers
types.setTypeParser(types.builtins.INT8, val => parseInt(val, 10));

export type Database = {
  query: <T = unknown>(text: string, values?: unknown[]) => Promise<T[]>;
};

export function createDatabaseConnection(connectionString: string): Database {
  const pool = new Pool({
    connectionString,
    max: 100,
    statement_timeout: 10 * 1000,
  });

  pool.on('error', error => console.error('Pool:error - Unexpected error on idle client', error));

  return {
    query: async <T = unknown>(text: string, values: unknown[] = []): Promise<T[]> => {
      const result = await pool.query(text, values);
      return (result.rows ?? []) as T[];
    },
  };
}
