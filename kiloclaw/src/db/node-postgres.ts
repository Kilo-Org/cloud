/**
 * pg Client implementation of the Database facade.
 *
 * Creates a new connection per query/transaction -- the expected pattern
 * for Cloudflare Hyperdrive, which pools connections at the infrastructure level.
 */

import { Client, types } from 'pg';
import type { Database, CreateDatabaseConnection } from './database';

// Parse INT8 (bigint) as JS numbers instead of strings
types.setTypeParser(types.builtins.INT8, val => parseInt(val, 10));

export const createNodePostgresConnection: CreateDatabaseConnection = connectionString => {
  const createConnectedClient = async (): Promise<Client> => {
    const client = new Client({ connectionString });
    await client.connect();
    return client;
  };

  return {
    __kind: 'Database',

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

    begin: async transactionFn => {
      const client = await createConnectedClient();
      try {
        await client.query('BEGIN');
        const result = await transactionFn({
          __kind: 'Transaction',
          query: async (text, values = {}) => {
            const { rows } = await client.query(text, Object.values(values));
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return rows ?? [];
          },
          rollback: async () => {
            await client.query('ROLLBACK');
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        await client.end();
      }
    },

    end: async () => {
      // no-op -- each operation manages its own client
    },
  } satisfies Database;
};
