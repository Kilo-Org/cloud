import {
  buildExaUsageLogPartitionIndexDefinitions,
  buildExaUsageLogPartitionIndexDropStatement,
  provisionComputeUsageChargePartitions,
  provisionEnkryptUsagePartitions,
  provisionExaUsageLogPartitions,
} from '@/lib/usage-partitions';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '@kilocode/web-shared/lib/drizzle';

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

describe('compute usage charge partitions', () => {
  test('provisions current and next two monthly partitions', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const fakeDb = {
      execute: async (query: SQL) => {
        statements.push(dialect.sqlToQuery(query).sql);
        return { rows: [] };
      },
    };

    const result = await provisionComputeUsageChargePartitions(
      fakeDb as never,
      new Date(2026, 7, 4, 12)
    );

    expect(result).toEqual({
      created: [
        'compute_usage_charge_2026_08',
        'compute_usage_charge_2026_09',
        'compute_usage_charge_2026_10',
      ],
      errors: [],
    });
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain(
      'PARTITION OF "public"."compute_usage_charge" FOR VALUES FROM (\'2026-08-01\') TO (\'2026-09-01\')'
    );
    expect(statements[1]).toContain('"compute_usage_charge_2026_09"');
    expect(statements[2]).toContain('"compute_usage_charge_2026_10"');
  });
});

describe('Enkrypt usage partitions', () => {
  test.each([
    { now: new Date('2026-11-30T23:59:00Z'), months: ['2026-11', '2026-12', '2027-01', '2027-02'] },
    { now: new Date('2026-12-31T23:59:00Z'), months: ['2026-12', '2027-01', '2027-02', '2027-03'] },
    { now: new Date('2028-01-31T23:59:00Z'), months: ['2028-01', '2028-02', '2028-03', '2028-04'] },
    {
      now: new Date('2026-12-01T00:30:00+01:00'),
      months: ['2026-11', '2026-12', '2027-01', '2027-02'],
    },
    {
      now: new Date('2026-11-30T23:30:00-01:00'),
      months: ['2026-12', '2027-01', '2027-02', '2027-03'],
    },
  ])('provisions complete months across rollover from $now', async ({ now, months }) => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const fakeDb = {
      execute: async (query: SQL) => {
        statements.push(dialect.sqlToQuery(query).sql);
        return { rows: [] };
      },
    };

    const result = await provisionEnkryptUsagePartitions(fakeDb as never, now);
    const names = months.slice(0, 3).map(month => `enkrypt_usage_${month.replace('-', '_')}`);

    expect(result).toEqual({ created: names, errors: [] });
    expect(statements).toEqual(
      names.map(
        (name, index) =>
          `CREATE TABLE IF NOT EXISTS "public"."${name}" PARTITION OF "public"."enkrypt_usage" FOR VALUES FROM ('${months[index]}-01T00:00:00.000Z') TO ('${months[index + 1]}-01T00:00:00.000Z')`
      )
    );
  });

  test('uses the current month when no date is supplied', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 5, 15, 12));
    const fakeDb = { execute: jest.fn().mockResolvedValue({ rows: [] }) };

    try {
      await expect(provisionEnkryptUsagePartitions(fakeDb as never)).resolves.toEqual({
        created: ['enkrypt_usage_2026_06', 'enkrypt_usage_2026_07', 'enkrypt_usage_2026_08'],
        errors: [],
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('repeats idempotent DDL without altering existing partitions', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const fakeDb = {
      execute: async (query: SQL) => {
        statements.push(dialect.sqlToQuery(query).sql);
        return { rows: [] };
      },
    };
    const now = new Date(2026, 7, 4, 12);

    const first = await provisionEnkryptUsagePartitions(fakeDb as never, now);
    const second = await provisionEnkryptUsagePartitions(fakeDb as never, now);

    expect(first.errors).toEqual([]);
    expect(second).toEqual(first);
    expect(statements).toHaveLength(6);
    expect(statements.slice(3)).toEqual(statements.slice(0, 3));
    expect(statements.every(statement => statement.startsWith('CREATE TABLE IF NOT EXISTS '))).toBe(
      true
    );
  });

  test.each([new Error('permission denied'), 'connection lost'])(
    'reports a failed month and continues provisioning later months: %s',
    async error => {
      const fakeDb = {
        execute: jest
          .fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockRejectedValueOnce(error)
          .mockResolvedValue({ rows: [] }),
      };
      const now = new Date(2026, 10, 15, 12);

      await expect(provisionEnkryptUsagePartitions(fakeDb as never, now)).resolves.toEqual({
        created: ['enkrypt_usage_2026_11', 'enkrypt_usage_2027_01'],
        errors: [{ name: 'enkrypt_usage_2026_12', error }],
      });
      expect(fakeDb.execute).toHaveBeenCalledTimes(3);

      await expect(provisionEnkryptUsagePartitions(fakeDb as never, now)).resolves.toEqual({
        created: ['enkrypt_usage_2026_11', 'enkrypt_usage_2026_12', 'enkrypt_usage_2027_01'],
        errors: [],
      });
    }
  );

  test.each(['America/New_York', 'Asia/Tokyo'])(
    'extends the migration partitions with UTC boundaries in database timezone %s',
    async timeZone => {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1));
      const rollback = new Error('rollback Enkrypt timezone partitions');
      await expect(
        db.transaction(async tx => {
          await tx.execute(sql`SELECT set_config('TimeZone', ${timeZone}, true)`);
          const result = await provisionEnkryptUsagePartitions(tx, start);
          expect(result.errors).toEqual([]);
          await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
          const bounds = await tx.execute(sql`
            SELECT relname AS name, pg_get_expr(relpartbound, oid) AS bounds
            FROM pg_class
            WHERE relnamespace = 'public'::regnamespace AND relname IN (${sql.join(
              result.created.map(name => sql`${name}`),
              sql`, `
            )})
            ORDER BY relname
          `);
          expect(bounds.rows).toEqual(
            result.created.map((name, offset) => {
              const from = new Date(
                Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1)
              );
              const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
              return {
                name,
                bounds: `FOR VALUES FROM ('${from.toISOString().slice(0, 10)} 00:00:00+00') TO ('${to.toISOString().slice(0, 10)} 00:00:00+00')`,
              };
            })
          );
          throw rollback;
        })
      ).rejects.toBe(rollback);
    }
  );
});
