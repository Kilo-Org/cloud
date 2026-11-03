import type { BenchmarkModelSummary } from '@kilocode/auto-routing-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const deleteStatement = { kind: 'delete' };
  const where = vi.fn(() => deleteStatement);
  const deleteFrom = vi.fn(() => ({ where }));
  const insertValues = vi.fn((rows: unknown) => ({ kind: 'insert', rows }));
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

import { insertRun, replaceModelSummaries } from './db';

function makeSummary(model: string): BenchmarkModelSummary {
  return {
    model,
    routeKey: '*',
    accuracy: 0.9,
    avgCostUsd: 0.001,
    avgInputTokens: 100.5,
    avgCachedInputTokens: 40.25,
    avgOutputTokens: 20.5,
    avgReasoningTokens: 10.75,
    avgLatencyMs: 100,
    p50LatencyMs: 90,
    p95LatencyMs: 120,
    cases: 216,
    errors: 0,
    timeouts: 0,
    routeAccuracy: null,
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
    // 18 bind values per row × 5 rows = 90 < 100 D1 variable ceiling.
    expect(mocks.insertValues.mock.calls.map(([rows]) => (rows as unknown[]).length)).toEqual([
      5, 5,
    ]);
    expect(mocks.insertValues.mock.calls[0]?.[0]).toContainEqual(
      expect.objectContaining({
        avg_input_tokens: 100.5,
        avg_cached_input_tokens: 40.25,
        avg_output_tokens: 20.5,
        avg_reasoning_tokens: 10.75,
        carried: false,
      })
    );
    expect(mocks.batch).toHaveBeenCalledTimes(1);
    expect(mocks.batch.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it('stores absent token averages from older summaries as null', async () => {
    await replaceModelSummaries({} as D1Database, 'run-1', [
      {
        ...makeSummary('model/legacy'),
        avgInputTokens: undefined,
        avgCachedInputTokens: undefined,
        avgOutputTokens: undefined,
        avgReasoningTokens: undefined,
      },
    ]);

    expect(mocks.insertValues.mock.calls[0]?.[0]).toContainEqual(
      expect.objectContaining({
        avg_input_tokens: null,
        avg_cached_input_tokens: null,
        avg_output_tokens: null,
        avg_reasoning_tokens: null,
      })
    );
  });
});

describe('insertRun', () => {
  beforeEach(() => {
    mocks.batch.mockClear();
    mocks.deleteFrom.mockClear();
    mocks.insertInto.mockClear();
    mocks.insertValues.mockClear();
    mocks.where.mockClear();
  });

  it('chunks carried summary inserts to stay below D1 SQL variable limits', async () => {
    const summaries = Array.from({ length: 10 }, (_, i) => makeSummary(`model/${i}`));

    await insertRun(
      {} as D1Database,
      {
        id: 'run-1',
        kind: 'decider',
        startedAt: '2026-06-17T00:00:00.000Z',
        min_accuracy: 0.7,
        switch_cost_factor: 3,
        best_accuracy_switch_threshold: 0.05,
        max_concurrency: 100,
        benchmark_user_id: 'user-123',
        benchmark_org_id: null,
        repetitions: 1,
        classifier_max_p95_latency_ms: null,
        engine_identity: 'v1:test',
      },
      [],
      summaries
    );

    const carriedInsertSizes = mocks.insertValues.mock.calls
      .map(([rows]) => rows)
      .filter(Array.isArray)
      .map(rows => rows.length);
    expect(carriedInsertSizes).toEqual([5, 5]);
    expect(mocks.insertValues.mock.calls[1]?.[0]).toContainEqual(
      expect.objectContaining({
        avg_input_tokens: 100.5,
        avg_cached_input_tokens: 40.25,
        avg_output_tokens: 20.5,
        avg_reasoning_tokens: 10.75,
        carried: true,
      })
    );
    expect(mocks.batch).toHaveBeenCalledTimes(1);
    expect(mocks.batch.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it('chunks run_models inserts to stay below D1 SQL variable limits', async () => {
    // 33 entries is the profile-drain batch size that failed in production:
    // unchunked it binds 165 variables and D1 rejects the whole run insert.
    const models = Array.from({ length: 33 }, (_, i) => ({
      run_id: 'run-1',
      model: `model/${i}`,
      variant: '',
      enqueued: true,
      reasoning_effort: null,
    }));

    await insertRun(
      {} as D1Database,
      {
        id: 'run-1',
        kind: 'decider',
        startedAt: '2026-06-17T00:00:00.000Z',
        min_accuracy: 0.7,
        switch_cost_factor: 3,
        best_accuracy_switch_threshold: 0.05,
        max_concurrency: 100,
        benchmark_user_id: 'user-123',
        benchmark_org_id: null,
        repetitions: 1,
        classifier_max_p95_latency_ms: null,
        engine_identity: 'v1:test',
      },
      models,
      []
    );

    // 5 bind values per row × 18 rows = 90 < 100 D1 variable ceiling.
    const modelInsertSizes = mocks.insertValues.mock.calls
      .map(([rows]) => rows)
      .filter(Array.isArray)
      .map(rows => rows.length);
    expect(modelInsertSizes).toEqual([18, 15]);
    expect(mocks.batch).toHaveBeenCalledTimes(1);
    // run insert + two run_models chunks.
    expect(mocks.batch.mock.calls[0]?.[0]).toHaveLength(3);
  });
});
