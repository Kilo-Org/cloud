import {
  parseExaUsageLogIndexScriptArgs,
  provisionHistoricalExaUsageLogIndexes,
} from '@/scripts/db/exa-usage-log-indexes';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

describe('Exa usage-log index operator', () => {
  test('defaults to dry-run without a partition limit or pacing', () => {
    expect(parseExaUsageLogIndexScriptArgs([])).toEqual({
      execute: false,
      sleepMs: 0,
    });
  });

  test('parses bounded execution and pacing options', () => {
    expect(
      parseExaUsageLogIndexScriptArgs(['--execute', '--max-partitions', '3', '--sleep-ms', '250'])
    ).toEqual({
      execute: true,
      maxPartitions: 3,
      sleepMs: 250,
    });
  });

  test('rejects unsafe or ambiguous arguments', () => {
    expect(() => parseExaUsageLogIndexScriptArgs(['--max-partitions', '0'])).toThrow(
      '--max-partitions must be a positive safe integer'
    );
    expect(() => parseExaUsageLogIndexScriptArgs(['--sleep-ms', '-1'])).toThrow(
      '--sleep-ms must be a non-negative integer'
    );
    expect(() => parseExaUsageLogIndexScriptArgs(['--execute', '--execute'])).toThrow(
      'Duplicate flag: --execute'
    );
    expect(() => parseExaUsageLogIndexScriptArgs(['--all'])).toThrow('Unknown flag: --all');
  });

  test('dry-run reads catalog partitions without executing index DDL', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const fakeDb = {
      execute: async (query: SQL) => {
        statements.push(dialect.sqlToQuery(query).sql);
        return {
          rows: [{ schema_name: 'public', partition_name: 'exa_usage_log_2026_06' }],
        };
      },
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await provisionHistoricalExaUsageLogIndexes(fakeDb as never, {
        execute: false,
        sleepMs: 0,
      });
    } finally {
      log.mockRestore();
    }

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('pg_catalog.pg_partition_tree');
    expect(statements[0]).toContain('partition_tree.isleaf');
    expect(statements[0]).toContain('partition_class.relispartition');
  });

  test('inspects, creates, and verifies both concurrent indexes sequentially', async () => {
    const statements: string[] = [];
    const catalogParams: unknown[][] = [];
    const dialect = new PgDialect();
    const validIndexes = new Set<string>();
    let activeExecutions = 0;
    let maximumActiveExecutions = 0;
    const fakeDb = {
      execute: async (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        statements.push(compiled.sql);
        if (statements.length === 1) {
          return {
            rows: [
              { schema_name: 'public', partition_name: 'exa_usage_log_2026_06' },
              { schema_name: 'public', partition_name: 'exa_usage_log_2026_05' },
            ],
          };
        }
        if (compiled.sql.includes('FROM pg_catalog.pg_index')) {
          catalogParams.push(compiled.params);
          const indexName = String(compiled.params[1]);
          return {
            rows: validIndexes.has(indexName)
              ? [
                  {
                    schema_name: 'public',
                    index_name: indexName,
                    partition_schema_name: 'public',
                    partition_name: 'exa_usage_log_2026_06',
                    is_valid: true,
                    is_ready: true,
                  },
                ]
              : [],
          };
        }

        activeExecutions++;
        maximumActiveExecutions = Math.max(maximumActiveExecutions, activeExecutions);
        const createdIndexName = compiled.sql.match(
          /CREATE INDEX CONCURRENTLY IF NOT EXISTS "([^"]+)"/
        )?.[1];
        if (createdIndexName) validIndexes.add(createdIndexName);
        await Promise.resolve();
        activeExecutions--;
        return { rows: [] };
      },
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await provisionHistoricalExaUsageLogIndexes(fakeDb as never, {
        execute: true,
        maxPartitions: 1,
        sleepMs: 0,
      });
    } finally {
      log.mockRestore();
    }

    expect(maximumActiveExecutions).toBe(1);
    expect(catalogParams).toEqual([
      ['public', 'exa_usage_log_2026_06_charged_created_at_idx'],
      ['public', 'exa_usage_log_2026_06_charged_created_at_idx'],
      ['public', 'exa_usage_log_2026_06_charged_org_created_at_idx'],
      ['public', 'exa_usage_log_2026_06_charged_org_created_at_idx'],
    ]);
    expect(statements.filter(statement => statement.startsWith('CREATE INDEX'))).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "exa_usage_log_2026_06_charged_created_at_idx" ON "public"."exa_usage_log_2026_06" ("created_at") WHERE "charged_to_balance" = true AND "cost_microdollars" > 0',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "exa_usage_log_2026_06_charged_org_created_at_idx" ON "public"."exa_usage_log_2026_06" ("organization_id", "created_at") WHERE "organization_id" IS NOT NULL AND "charged_to_balance" = true AND "cost_microdollars" > 0',
    ]);
    expect(
      statements.filter(statement => statement.includes('FROM pg_catalog.pg_index'))
    ).toHaveLength(4);
    expect(statements[1]).toContain('index_namespace.nspname = $1');
    expect(statements[1]).toContain('index_catalog.indisvalid AS is_valid');
    expect(statements[1]).toContain('index_catalog.indisready AS is_ready');
  });

  test('drops and rebuilds an interrupted invalid concurrent index', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    let firstIndexState: 'invalid' | 'missing' | 'valid' = 'invalid';
    const firstIndexName = 'exa_usage_log_2026_06_charged_created_at_idx';
    const secondIndexName = 'exa_usage_log_2026_06_charged_org_created_at_idx';
    const fakeDb = {
      execute: async (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        statements.push(compiled.sql);
        if (statements.length === 1) {
          return { rows: [{ schema_name: 'public', partition_name: 'exa_usage_log_2026_06' }] };
        }
        if (compiled.sql.includes('FROM pg_catalog.pg_index')) {
          const indexName = String(compiled.params[1]);
          const state = indexName === firstIndexName ? firstIndexState : 'valid';
          return {
            rows:
              state === 'missing'
                ? []
                : [
                    {
                      schema_name: 'public',
                      index_name: indexName,
                      partition_schema_name: 'public',
                      partition_name: 'exa_usage_log_2026_06',
                      is_valid: state === 'valid',
                      is_ready: state === 'valid',
                    },
                  ],
          };
        }
        if (compiled.sql.startsWith('DROP INDEX')) firstIndexState = 'missing';
        if (compiled.sql.includes(`"${firstIndexName}"`)) firstIndexState = 'valid';
        return { rows: [] };
      },
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await provisionHistoricalExaUsageLogIndexes(fakeDb as never, {
        execute: true,
        sleepMs: 0,
      });
    } finally {
      log.mockRestore();
    }

    expect(statements.filter(statement => statement.startsWith('DROP INDEX'))).toEqual([
      `DROP INDEX CONCURRENTLY IF EXISTS "public"."${firstIndexName}"`,
    ]);
    expect(statements.filter(statement => statement.startsWith('CREATE INDEX'))).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "exa_usage_log_2026_06_charged_created_at_idx" ON "public"."exa_usage_log_2026_06" ("created_at") WHERE "charged_to_balance" = true AND "cost_microdollars" > 0',
    ]);
    expect(statements.some(statement => statement.includes(`"${secondIndexName}"`))).toBe(false);
  });

  test('fails when final catalog state is not valid and ready', async () => {
    const dialect = new PgDialect();
    let statementCount = 0;
    const fakeDb = {
      execute: async (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        statementCount++;
        if (statementCount === 1) {
          return { rows: [{ schema_name: 'public', partition_name: 'exa_usage_log_2026_06' }] };
        }
        if (compiled.sql.includes('FROM pg_catalog.pg_index')) {
          return statementCount === 2
            ? { rows: [] }
            : {
                rows: [
                  {
                    schema_name: 'public',
                    index_name: 'exa_usage_log_2026_06_charged_created_at_idx',
                    partition_schema_name: 'public',
                    partition_name: 'exa_usage_log_2026_06',
                    is_valid: false,
                    is_ready: true,
                  },
                ],
              };
        }
        return { rows: [] };
      },
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(
        provisionHistoricalExaUsageLogIndexes(fakeDb as never, {
          execute: true,
          sleepMs: 0,
        })
      ).rejects.toThrow('is not valid and ready after provisioning');
    } finally {
      log.mockRestore();
    }
  });

  test('rejects unsafe partition identifiers returned by the catalog', async () => {
    const dialect = new PgDialect();
    const statements: string[] = [];
    const fakeDb = {
      execute: async (query: SQL) => {
        statements.push(dialect.sqlToQuery(query).sql);
        return {
          rows: [
            {
              schema_name: 'public',
              partition_name: 'exa_usage_log_2026_06"; DROP TABLE exa_usage_log; --',
            },
          ],
        };
      },
    };

    await expect(
      provisionHistoricalExaUsageLogIndexes(fakeDb as never, {
        execute: true,
        sleepMs: 0,
      })
    ).rejects.toThrow('Invalid Exa usage-log partition name');
    expect(statements).toHaveLength(1);
  });
});
