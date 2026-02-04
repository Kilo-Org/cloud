import { Pool, types } from 'pg';

import type { CreateDatabaseConnection, Database } from './database.js';

// Default postgres behavior is to use strings for big ints. This parses them
// as regular numbers
types.setTypeParser(types.builtins.INT8, val => parseInt(val, 10));

// Ensure timestamptz values are properly handled as Date objects
// types.setTypeParser(types.builtins.TIMESTAMPTZ, (val) => new Date(val))
// types.setTypeParser(types.builtins.TIMESTAMP, (val) => new Date(val))

export const createNodePostgresConnection: CreateDatabaseConnection = connectionString => {
  const pool = new Pool({
    connectionString,
    max: 100,
    statement_timeout: 10 * 1000,
  });

  pool.on('error', error => console.error('Pool:error - Unexpected error on idle client', error));

  return {
    __kind: 'Database',
    begin: async transactionFn => {
      // Pull an available client from pg-pool
      const client = await pool.connect();

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
        // Always release the client back to the pool!
        client.release();
      }
    },
    end: async () => {
      // no-op with node-postgres since we just query from the pool
    },
    query: async (text, values = {}) => {
      const result = await pool.query(text, Object.values(values));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return result.rows ?? [];
    },
    // casting as Database here so we don't have to manually fill in function args
  } satisfies Database;
};
