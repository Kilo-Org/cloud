import type { BenchmarkModelSummary } from '@kilocode/auto-routing-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const deleteStatement = { kind: 'delete' };
  const where = vi.fn(() => deleteStatement);
  const deleteFrom = vi.fn(() => ({ where }));
  const insertValues = vi.fn((rows: unknown[]) => ({ kind: 'insert', rows }));
  const insertInto = vi.fn(() => ({ values: insertValues }));
  const batch = vi.fn(async (_stmts: unknown[]) => []);

  return { batch, deleteFrom, deleteStatement, insertInto, insertValues, where };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    batch: mocks.batch,
    delete: mocks.deleteFrom,
    insert: mocks.insertInto,
  })),
}));

import { replaceModelSummaries } from './db';

function makeSummary(model: string): BenchmarkModelSummary {
  return {
    model,
    tier: '*',
    accuracy: 0.9,
    avgCostUsd: 0.001,
    avgLatencyMs: 100,
    p50LatencyMs: 90,
    p95LatencyMs: 120,
    cases: 216,
    errors: 0,
    timeouts: 0,
  };
}

describe('replaceModelSummaries', () => {
  beforeEach(() => {
    mocks.batch.mockClear();
    mocks.deleteFrom.mockClear();
    mocks.insertInto.mockClear();
    mocks.insertValues.mockClear();
    mocks.where.mockClear();
  });

  it('chunks summary inserts to stay below D1 SQL variable limits', async () => {
    const summaries = Array.from({ length: 10 }, (_, i) => makeSummary(`model/${i}`));

    await replaceModelSummaries({} as D1Database, 'run-1', summaries);

    expect(mocks.insertValues).toHaveBeenCalledTimes(2);
    expect(mocks.insertValues.mock.calls.map(([rows]) => (rows as unknown[]).length)).toEqual([
      8, 2,
    ]);
    expect(mocks.batch).toHaveBeenCalledTimes(1);
    expect(mocks.batch.mock.calls[0]?.[0]).toHaveLength(3);
  });
});
