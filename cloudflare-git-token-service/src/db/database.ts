import { Client, types } from 'pg';

// Default postgres behavior is to use strings for big ints. This parses them as regular numbers
types.setTypeParser(types.builtins.INT8, val => parseInt(val, 10));

export type Database = {
  query: <T = unknown>(text: string, values?: unknown[]) => Promise<T[]>;
};

/**
 * Creates a new connection per query -- the expected pattern
 * for Cloudflare Hyperdrive, which pools connections at the infrastructure level.
 */
export function createDatabaseConnection(connectionString: string): Database {
  return {
    query: async <T = unknown>(text: string, values: unknown[] = []): Promise<T[]> => {
      const client = new Client({ connectionString, statement_timeout: 10_000 });
      await client.connect();
      try {
        const result = await client.query(text, values);
        return (result.rows ?? []) as T[];
      } finally {
        await client.end();
      }
    },
  };
}
