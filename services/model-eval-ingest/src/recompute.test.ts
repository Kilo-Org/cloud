import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelStatsKiloBenchSchema } from '@kilocode/db/schema';
import { buildKiloBenchCache, recomputeModelStatsKiloBench } from './recompute.js';

type LatestPromotionRow = Parameters<typeof buildKiloBenchCache>[0][number];

function row(overrides: Partial<LatestPromotionRow> = {}): LatestPromotionRow {
  return {
    task_source: 'terminal-bench',
    total_score: '1.5',
    overall_score: '0.375',
    n_total_trials: 4,
    avg_cost_usd: '0.420000',
    avg_input_tokens: 1_000,
    avg_output_tokens: 500,
    avg_cache_read_tokens: 250,
    avg_execution_ms: 12_000,
    promoted_at: '2026-05-13T12:00:00.000Z',
    ...overrides,
  };
}

function makeAwaitable<T>(value: T) {
  return {
    then(resolve: (resolved: T) => unknown) {
      return Promise.resolve(resolve(value));
    },
  };
}

function createDb(options: {
  exactTarget?: { id: string; openrouterId: string };
  fallbackTarget?: { id: string; openrouterId: string };
  rows: LatestPromotionRow[];
}) {
  let selectCalls = 0;
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: () => {
          selectCalls += 1;
          if (selectCalls === 1)
            return makeAwaitable(options.exactTarget ? [options.exactTarget] : []);
          return makeAwaitable(options.fallbackTarget ? [options.fallbackTarget] : []);
        },
      }),
    }),
  }));

  const execute = vi.fn(async () => ({ rows: options.rows }));
  const updateValues: unknown[] = [];
  const update = vi.fn(() => ({
    set: (values: unknown) => {
      updateValues.push(values);
      return {
        where: () => Promise.resolve(undefined),
      };
    },
  }));

  return {
    db: { select, execute, update },
    select,
    execute,
    update,
    updateValues,
  };
}

describe('buildKiloBenchCache', () => {
  it('builds a public cache with weighted overall score and no audit-only fields', () => {
    const cache = buildKiloBenchCache([
      row(),
      row({
        task_source: 'swebench-verified',
        total_score: '9',
        overall_score: '0.9',
        n_total_trials: 10,
        promoted_at: '2026-05-13T13:00:00.000Z',
      }),
    ]);

    expect(cache.overallScore).toBeCloseTo(10.5 / 14);
    expect(cache.evals['terminal-bench']).toMatchObject({
      taskSource: 'terminal-bench',
      overallScore: 0.375,
      totalScore: 1.5,
      nTotalTrials: 4,
    });
    expect(cache.evals['terminal-bench']).not.toHaveProperty('nErrored');
    expect(cache.evals['terminal-bench']).not.toHaveProperty('benchEvalUrl');
    expect(ModelStatsKiloBenchSchema.parse(cache)).toEqual(cache);
  });

  it('uses the latest row provided for a task source in the cache record', () => {
    const cache = buildKiloBenchCache([
      row({
        total_score: '1',
        overall_score: '0.25',
        promoted_at: '2026-05-13T12:00:00.000Z',
      }),
      row({
        total_score: '3',
        overall_score: '0.75',
        promoted_at: '2026-05-13T13:00:00.000Z',
      }),
    ]);

    expect(cache.evals['terminal-bench']).toMatchObject({
      overallScore: 0.75,
      totalScore: 3,
      lastPromotedAt: '2026-05-13T13:00:00.000Z',
    });
  });
});

describe('recomputeModelStatsKiloBench', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('updates the exact matching OpenRouter variant model', async () => {
    const db = createDb({
      exactTarget: { id: 'stats-exact', openrouterId: 'anthropic/claude-sonnet-4.6:thinking' },
      rows: [row()],
    });

    const updated = await recomputeModelStatsKiloBench(db.db as never, {
      provider: 'anthropic',
      model: 'claude-sonnet-4.6',
      variant: 'thinking',
    });

    expect(updated).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('falls back from a missing variant model to the unspecified base model', async () => {
    const db = createDb({
      fallbackTarget: { id: 'stats-base', openrouterId: 'anthropic/claude-sonnet-4.6' },
      rows: [row()],
    });

    const updated = await recomputeModelStatsKiloBench(db.db as never, {
      provider: 'anthropic',
      model: 'claude-sonnet-4.6',
      variant: 'thinking',
    });

    expect(updated).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('logs and skips cache writes when no model stats target exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = createDb({ rows: [row()] });

    const updated = await recomputeModelStatsKiloBench(db.db as never, {
      provider: 'anthropic',
      model: 'claude-sonnet-4.6',
      variant: null,
    });

    expect(updated).toBe(false);
    expect(db.update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
