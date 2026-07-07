import {
  parseCostInsightsSourceIndexScriptArgs,
  provisionCostInsightsSourceIndexes,
} from '../scripts/db/cost-insights-source-indexes';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

describe('Cost Insights source index operator', () => {
  test('defaults to dry-run and parses execute', () => {
    expect(parseCostInsightsSourceIndexScriptArgs([])).toEqual({ execute: false });
    expect(parseCostInsightsSourceIndexScriptArgs(['--execute'])).toEqual({ execute: true });
    expect(() => parseCostInsightsSourceIndexScriptArgs(['--execute', '--again'])).toThrow(
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
      await provisionCostInsightsSourceIndexes(fakeDb as never, { execute: false });
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
    const validIndexes = new Map<string, string>();
    const fakeDb = {
      execute: async (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        statements.push(compiled.sql);
        if (compiled.sql.includes('FROM pg_catalog.pg_index')) {
          const indexName = String(compiled.params[0]);
          const tableName = validIndexes.get(indexName);
          return {
            rows: tableName
              ? [
                  {
                    schema_name: 'public',
                    index_name: indexName,
                    table_schema_name: 'public',
                    table_name: tableName,
                    is_valid: true,
                    is_ready: true,
                  },
                ]
              : [],
          };
        }
        const createdIndex = compiled.sql.match(
          /CREATE INDEX CONCURRENTLY IF NOT EXISTS "([^"]+)" ON "([^"]+)"/
        );
        if (createdIndex) validIndexes.set(createdIndex[1], createdIndex[2]);
        return { rows: [] };
      },
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await provisionCostInsightsSourceIndexes(fakeDb as never, { execute: true });
    } finally {
      log.mockRestore();
    }

    expect(statements.filter(statement => statement.startsWith('CREATE INDEX'))).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_coding_plan_terms_credit_transaction" ON "coding_plan_terms" ("credit_transaction_id")',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_microdollar_usage_org_created_at" ON "microdollar_usage" ("organization_id", "created_at") WHERE "organization_id" IS NOT NULL',
    ]);
    expect(
      statements.filter(statement => statement.includes('FROM pg_catalog.pg_index'))
    ).toHaveLength(4);
  });

  test('drops and rebuilds invalid concurrent index attempts', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const indexName = 'idx_microdollar_usage_org_created_at';
    const indexTables = new Map([
      ['IDX_coding_plan_terms_credit_transaction', 'coding_plan_terms'],
      ['idx_microdollar_usage_org_created_at', 'microdollar_usage'],
    ]);
    let state: 'invalid' | 'missing' | 'valid' = 'invalid';
    const fakeDb = {
      execute: async (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        statements.push(compiled.sql);
        if (compiled.sql.includes('FROM pg_catalog.pg_index')) {
          const queriedIndexName = String(compiled.params[0]);
          const tableName = indexTables.get(queriedIndexName);
          if (queriedIndexName !== indexName) {
            return {
              rows: [
                {
                  schema_name: 'public',
                  index_name: queriedIndexName,
                  table_schema_name: 'public',
                  table_name: tableName,
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
                      table_name: tableName,
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
      await provisionCostInsightsSourceIndexes(fakeDb as never, { execute: true });
    } finally {
      log.mockRestore();
    }

    expect(statements.filter(statement => statement.startsWith('DROP INDEX'))).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_microdollar_usage_org_created_at"',
    ]);
  });
});
