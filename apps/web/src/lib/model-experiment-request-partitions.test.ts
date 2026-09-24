import { describe, expect, test } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { provisionModelExperimentRequestPartitions } from '@/lib/model-experiment-request-partitions';

describe('model experiment request partitions', () => {
  test('provisions current month and two months ahead', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const fakeDb = {
      execute: async (query: SQL) => {
        statements.push(dialect.sqlToQuery(query).sql);
        return { rows: [] };
      },
    };

    const result = await provisionModelExperimentRequestPartitions(
      fakeDb as never,
      new Date(2026, 7, 15, 12) // August 2026
    );

    expect(result).toEqual({
      created: [
        'model_experiment_request_2026_08',
        'model_experiment_request_2026_09',
        'model_experiment_request_2026_10',
      ],
      errors: [],
    });
    expect(statements).toEqual([
      `CREATE TABLE IF NOT EXISTS "model_experiment_request_2026_08" PARTITION OF "model_experiment_request" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01')`,
      `CREATE TABLE IF NOT EXISTS "model_experiment_request_2026_09" PARTITION OF "model_experiment_request" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01')`,
      `CREATE TABLE IF NOT EXISTS "model_experiment_request_2026_10" PARTITION OF "model_experiment_request" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')`,
    ]);
  });

  test('collects per-partition failures without stopping the window', async () => {
    let calls = 0;
    const result = await provisionModelExperimentRequestPartitions(
      {
        execute: async () => {
          calls += 1;
          if (calls === 2) throw new Error('boom');
          return { rows: [] };
        },
      } as never,
      new Date(2026, 7, 1)
    );

    expect(result.created).toEqual([
      'model_experiment_request_2026_08',
      'model_experiment_request_2026_10',
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe('model_experiment_request_2026_09');
  });
});
