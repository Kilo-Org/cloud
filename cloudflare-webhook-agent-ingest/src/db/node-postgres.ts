import { Client, types } from 'pg';

import type { CreateDatabaseConnection, Database } from './database.js';

// Default postgres behavior is to use strings for big ints. This parses them
// as regular numbers
types.setTypeParser(types.builtins.INT8, val => parseInt(val, 10));

// Ensure timestamptz values are properly handled as Date objects
// types.setTypeParser(types.builtins.TIMESTAMPTZ, (val) => new Date(val))
// types.setTypeParser(types.builtins.TIMESTAMP, (val) => new Date(val))

/**
 * Creates a new database connection for each invocation.
 */
export const createNodePostgresConnection: CreateDatabaseConnection = connectionString => {
  // Helper to create and connect a new client
  const createConnectedClient = async (): Promise<Client> => {
    const client = new Client({ connectionString });
    await client.connect();
    return client;
  };

  return {
    __kind: 'Database',
    begin: async transactionFn => {
      const client = await createConnectedClient();

      try {
        // Start the transaction
        await client.query('begin');

        // Call user provided transaction function
        const result = await transactionFn({
          __kind: 'Transaction',
          query: async (text, values = {}) => {
            const { rows } = await client.query(text, Object.values(values));
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return rows ?? [];
          },
          rollback: async () => {
            await client.query('rollback');
          },
        });

        // Commit the results
        await client.query('commit');

        return result;
      } catch (e) {
        // Rollback if there were any errors
        await client.query('rollback');
        throw e;
      } finally {
        // Always close the client connection
        await client.end();
      }
    },
    end: async () => {
      // no-op - each operation manages its own client
    },
    query: async (text, values = {}) => {
      const client = await createConnectedClient();
      try {
        const result = await client.query(text, Object.values(values));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return result.rows ?? [];
      } finally {
        await client.end();
      }
    },
  } satisfies Database;
};
