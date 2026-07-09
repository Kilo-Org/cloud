import {
  parseCreditTransactionIndexScriptArgs,
  provisionCreditTransactionIndexes,
} from '@/scripts/db/credit-transaction-indexes';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

describe('Credit transaction index operator', () => {
  test('defaults to dry-run and parses execute', () => {
    expect(parseCreditTransactionIndexScriptArgs([])).toEqual({ execute: false });
    expect(parseCreditTransactionIndexScriptArgs(['--execute'])).toEqual({ execute: true });
    expect(() => parseCreditTransactionIndexScriptArgs(['--execute', '--again'])).toThrow(
      'Unknown arguments'
    );
  });

  test('dry-run inspects both indexes without DDL', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const fakeDb = {
      execute: async (query: SQL) => {
        statements.push(dialect.sqlToQuery(query).sql);
        return { rows: [] };
      },
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await provisionCreditTransactionIndexes(fakeDb as never, { execute: false });
    } finally {
      log.mockRestore();
    }

    expect(statements).toHaveLength(2);
    expect(statements.every(statement => statement.includes('FROM pg_catalog.pg_index'))).toBe(
      true
    );
  });

  test('creates missing indexes concurrently and verifies catalog state', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const validIndexes = new Set<string>();
    const fakeDb = {
      execute: async (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        statements.push(compiled.sql);
        if (compiled.sql.includes('FROM pg_catalog.pg_index')) {
          const indexName = String(compiled.params[0]);
          return {
            rows: validIndexes.has(indexName)
              ? [
                  {
                    schema_name: 'public',
                    index_name: indexName,
                    table_schema_name: 'public',
                    table_name: 'credit_transactions',
                    is_valid: true,
                    is_ready: true,
                  },
                ]
              : [],
          };
        }
        const createdIndexName = compiled.sql.match(
          /CREATE INDEX CONCURRENTLY IF NOT EXISTS "([^"]+)"/
        )?.[1];
        if (createdIndexName) validIndexes.add(createdIndexName);
        return { rows: [] };
      },
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await provisionCreditTransactionIndexes(fakeDb as never, { execute: true });
    } finally {
      log.mockRestore();
    }

    expect(statements.filter(statement => statement.startsWith('CREATE INDEX'))).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_credit_transactions_user_negative_created" ON "credit_transactions" ("kilo_user_id", "created_at") WHERE "amount_microdollars" < 0',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_credit_transactions_org_negative_created" ON "credit_transactions" ("organization_id", "created_at") WHERE "amount_microdollars" < 0 AND "organization_id" IS NOT NULL',
    ]);
    expect(
      statements.filter(statement => statement.includes('FROM pg_catalog.pg_index'))
    ).toHaveLength(4);
  });

  test('drops and rebuilds invalid concurrent index attempts', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const indexName = 'IDX_credit_transactions_user_negative_created';
    let state: 'invalid' | 'missing' | 'valid' = 'invalid';
    const fakeDb = {
      execute: async (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        statements.push(compiled.sql);
        if (compiled.sql.includes('FROM pg_catalog.pg_index')) {
          const queriedIndexName = String(compiled.params[0]);
          if (queriedIndexName !== indexName) {
            return {
              rows: [
                {
                  schema_name: 'public',
                  index_name: queriedIndexName,
                  table_schema_name: 'public',
                  table_name: 'credit_transactions',
                  is_valid: true,
                  is_ready: true,
                },
              ],
            };
          }
          return {
            rows:
              state === 'missing'
                ? []
                : [
                    {
                      schema_name: 'public',
                      index_name: indexName,
                      table_schema_name: 'public',
                      table_name: 'credit_transactions',
                      is_valid: state === 'valid',
                      is_ready: state === 'valid',
                    },
                  ],
          };
        }
        if (compiled.sql.startsWith('DROP INDEX')) state = 'missing';
        if (compiled.sql.includes(`"${indexName}"`) && compiled.sql.startsWith('CREATE INDEX')) {
          state = 'valid';
        }
        return { rows: [] };
      },
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await provisionCreditTransactionIndexes(fakeDb as never, { execute: true });
    } finally {
      log.mockRestore();
    }

    expect(statements.filter(statement => statement.startsWith('DROP INDEX'))).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS "public"."IDX_credit_transactions_user_negative_created"',
    ]);
  });
});
