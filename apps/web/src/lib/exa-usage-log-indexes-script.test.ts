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

  test('executes both concurrent indexes sequentially for selected catalog partitions', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    let activeExecutions = 0;
    let maximumActiveExecutions = 0;
    const fakeDb = {
      execute: async (query: SQL) => {
        const statement = dialect.sqlToQuery(query).sql;
        statements.push(statement);
        if (statements.length === 1) {
          return {
            rows: [
              { schema_name: 'public', partition_name: 'exa_usage_log_2026_06' },
              { schema_name: 'public', partition_name: 'exa_usage_log_2026_05' },
            ],
          };
        }
        activeExecutions++;
        maximumActiveExecutions = Math.max(maximumActiveExecutions, activeExecutions);
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
    expect(statements.slice(1)).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "exa_usage_log_2026_06_charged_created_at_idx" ON "public"."exa_usage_log_2026_06" ("created_at") WHERE "charged_to_balance" = true AND "cost_microdollars" > 0',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "exa_usage_log_2026_06_charged_org_created_at_idx" ON "public"."exa_usage_log_2026_06" ("organization_id", "created_at") WHERE "organization_id" IS NOT NULL AND "charged_to_balance" = true AND "cost_microdollars" > 0',
    ]);
  });
});
