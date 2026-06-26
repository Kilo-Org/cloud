import {
  buildExaUsageLogPartitionIndexDefinitions,
  buildExaUsageLogPartitionIndexDropStatement,
  provisionExaUsageLogPartitions,
} from '@/lib/exa-usage-partitions';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

describe('Exa usage-log partition indexes', () => {
  test('builds regular local partial indexes for future partitions', () => {
    expect(
      buildExaUsageLogPartitionIndexDefinitions('public', 'exa_usage_log_2026_07', false)
    ).toEqual([
      {
        name: 'exa_usage_log_2026_07_charged_created_at_idx',
        statement:
          'CREATE INDEX IF NOT EXISTS "exa_usage_log_2026_07_charged_created_at_idx" ON "public"."exa_usage_log_2026_07" ("created_at") WHERE "charged_to_balance" = true AND "cost_microdollars" > 0',
      },
      {
        name: 'exa_usage_log_2026_07_charged_org_created_at_idx',
        statement:
          'CREATE INDEX IF NOT EXISTS "exa_usage_log_2026_07_charged_org_created_at_idx" ON "public"."exa_usage_log_2026_07" ("organization_id", "created_at") WHERE "organization_id" IS NOT NULL AND "charged_to_balance" = true AND "cost_microdollars" > 0',
      },
    ]);
  });

  test('builds concurrent statements for the historical operator path', () => {
    const definitions = buildExaUsageLogPartitionIndexDefinitions(
      'public',
      'exa_usage_log_2026_06',
      true
    );

    expect(definitions).toHaveLength(2);
    expect(
      definitions.every(({ statement }) =>
        statement.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS')
      )
    ).toBe(true);
  });

  test('builds a schema-qualified concurrent drop for a controlled index name', () => {
    expect(
      buildExaUsageLogPartitionIndexDropStatement(
        'public',
        'exa_usage_log_2026_07_charged_created_at_idx'
      )
    ).toBe(
      'DROP INDEX CONCURRENTLY IF EXISTS "public"."exa_usage_log_2026_07_charged_created_at_idx"'
    );
  });

  test('rejects identifiers outside the expected catalog naming contract', () => {
    expect(() =>
      buildExaUsageLogPartitionIndexDefinitions(
        'public',
        'exa_usage_log_2026_07"; DROP TABLE exa_usage_log; --',
        true
      )
    ).toThrow('Invalid Exa usage-log partition name');
    expect(() =>
      buildExaUsageLogPartitionIndexDefinitions(
        'public"; DROP SCHEMA public; --',
        'exa_usage_log_2026_07',
        true
      )
    ).toThrow('Unsafe PostgreSQL identifier');
    expect(() =>
      buildExaUsageLogPartitionIndexDropStatement(
        'public',
        'exa_usage_log_2026_07_charged_created_at_idx"; DROP TABLE exa_usage_log; --'
      )
    ).toThrow('Invalid Exa usage-log partition index name');
  });

  test('provisions indexes only on write-free future partitions', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const fakeDb = {
      execute: async (query: SQL) => {
        statements.push(dialect.sqlToQuery(query).sql);
        return { rows: [] };
      },
    };

    const result = await provisionExaUsageLogPartitions(fakeDb as never, new Date(2026, 5, 15, 12));

    expect(result).toEqual({
      created: ['exa_usage_log_2026_06', 'exa_usage_log_2026_07', 'exa_usage_log_2026_08'],
      errors: [],
    });
    expect(statements).toEqual([
      'CREATE TABLE IF NOT EXISTS "public"."exa_usage_log_2026_06" PARTITION OF "public"."exa_usage_log" FOR VALUES FROM (\'2026-06-01\') TO (\'2026-07-01\')',
      'CREATE TABLE IF NOT EXISTS "public"."exa_usage_log_2026_07" PARTITION OF "public"."exa_usage_log" FOR VALUES FROM (\'2026-07-01\') TO (\'2026-08-01\')',
      'CREATE INDEX IF NOT EXISTS "exa_usage_log_2026_07_charged_created_at_idx" ON "public"."exa_usage_log_2026_07" ("created_at") WHERE "charged_to_balance" = true AND "cost_microdollars" > 0',
      'CREATE INDEX IF NOT EXISTS "exa_usage_log_2026_07_charged_org_created_at_idx" ON "public"."exa_usage_log_2026_07" ("organization_id", "created_at") WHERE "organization_id" IS NOT NULL AND "charged_to_balance" = true AND "cost_microdollars" > 0',
      'CREATE TABLE IF NOT EXISTS "public"."exa_usage_log_2026_08" PARTITION OF "public"."exa_usage_log" FOR VALUES FROM (\'2026-08-01\') TO (\'2026-09-01\')',
      'CREATE INDEX IF NOT EXISTS "exa_usage_log_2026_08_charged_created_at_idx" ON "public"."exa_usage_log_2026_08" ("created_at") WHERE "charged_to_balance" = true AND "cost_microdollars" > 0',
      'CREATE INDEX IF NOT EXISTS "exa_usage_log_2026_08_charged_org_created_at_idx" ON "public"."exa_usage_log_2026_08" ("organization_id", "created_at") WHERE "organization_id" IS NOT NULL AND "charged_to_balance" = true AND "cost_microdollars" > 0',
    ]);
  });
});
