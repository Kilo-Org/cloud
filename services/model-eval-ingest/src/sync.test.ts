import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./recompute.js', () => ({
  recomputeModelStatsKiloBench: vi.fn(async () => true),
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

import { getWorkerDb } from '@kilocode/db/client';
import { recomputeModelStatsKiloBench } from './recompute.js';
import { syncFromBench } from './sync.js';

function promotion(overrides: Partial<PromotionRecord> = {}): PromotionRecord {
  return {
    bench_eval_name: 'eval-terminal-001',
    bench_eval_url: 'https://kilobench.ai/jobs/eval-terminal-001',
    provider: 'anthropic',
    model: 'claude-sonnet-4.6',
    variant: null,
    task_source: 'terminal-bench',
    n_total_trials: 4,
    total_score: 1.5,
    overall_score: 0.375,
    n_errored: 0,
    avg_cost_usd: 0.42,
    avg_input_tokens: 1_000,
    avg_output_tokens: 500,
    avg_cache_read_tokens: 250,
    avg_execution_ms: 12_000,
    promoted_at: 1_778_620_000_000,
    promoted_by_email: 'operator@kilocode.ai',
    promotion_note: null,
    ...overrides,
  };
}

function createEnv(records: PromotionRecord[]): CloudflareEnv {
  return {
    HYPERDRIVE: { connectionString: 'postgres://test' },
    BENCH_DASHBOARD: {
      listPromotions: vi.fn(async () => records),
      getPromotion: vi.fn(async () => null),
    },
  };
}

function createDb(options?: { maxPromotedAtMs?: number; existingNames?: Set<string> }) {
  const insertedRows: Array<Record<string, unknown>> = [];
  const existingNames = options?.existingNames ?? new Set<string>();
  const execute = vi.fn(async () => ({
    rows: [
      {
        max_promoted_at_ms:
          options?.maxPromotedAtMs === undefined ? null : String(options.maxPromotedAtMs),
      },
    ],
  }));

  const insert = vi.fn(() => ({
    values: (values: Record<string, unknown>) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          const benchEvalName = values.bench_eval_name;
          if (typeof benchEvalName !== 'string' || existingNames.has(benchEvalName)) {
            return [];
          }

          existingNames.add(benchEvalName);
          insertedRows.push(values);
          return [{ id: `ingest-${insertedRows.length}` }];
        },
      }),
    }),
  }));

  return {
    db: { execute, insert },
    execute,
    insert,
    insertedRows,
    existingNames,
  };
}

describe('syncFromBench', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('pulls and inserts all promoted evals into an empty ingest table', async () => {
    const records = [
      promotion(),
      promotion({
        bench_eval_name: 'eval-swebench-001',
        bench_eval_url: 'https://kilobench.ai/jobs/eval-swebench-001',
        task_source: 'swebench-verified',
      }),
    ];
    const env = createEnv(records);
    const { db, insertedRows } = createDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as unknown as ReturnType<typeof getWorkerDb>);

    const result = await syncFromBench(env);

    expect(env.BENCH_DASHBOARD.listPromotions).toHaveBeenCalledWith({
      sinceMs: 0,
      limit: 1_000,
    });
    expect(result).toEqual({ inserted: 2, alreadyHad: 0, fetched: 2, recomputed: 1, sinceMs: 0 });
    expect(insertedRows).toHaveLength(2);
    expect(recomputeModelStatsKiloBench).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate ingest rows during an idempotent rerun', async () => {
    const records = [promotion()];
    const env = createEnv(records);
    const dbFakes = createDb();
    vi.mocked(getWorkerDb).mockReturnValue(dbFakes.db as unknown as ReturnType<typeof getWorkerDb>);

    const first = await syncFromBench(env);
    const second = await syncFromBench(env);

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.alreadyHad).toBe(1);
    expect(dbFakes.insertedRows).toHaveLength(1);
  });

  it('preserves fractional score aggregates in the audit row insert', async () => {
    const env = createEnv([promotion({ total_score: 1.5, overall_score: 0.375 })]);
    const { db, insertedRows } = createDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as unknown as ReturnType<typeof getWorkerDb>);

    await syncFromBench(env);

    expect(insertedRows[0]).toMatchObject({
      total_score: '1.5',
      overall_score: '0.375',
      n_total_trials: 4,
    });
  });

  it('accepts bench legacy promoter placeholders for audit rows', async () => {
    const env = createEnv([promotion({ promoted_by_email: 'unknown' })]);
    const { db, insertedRows } = createDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as unknown as ReturnType<typeof getWorkerDb>);

    await syncFromBench(env);

    expect(insertedRows[0]).toMatchObject({ promoted_by_email: 'unknown' });
  });

  it('requests bench promotions from the persisted promoted_at watermark', async () => {
    const env = createEnv([]);
    const { db } = createDb({ maxPromotedAtMs: 1_778_620_123_456 });
    vi.mocked(getWorkerDb).mockReturnValue(db as unknown as ReturnType<typeof getWorkerDb>);

    const result = await syncFromBench(env);

    expect(env.BENCH_DASHBOARD.listPromotions).toHaveBeenCalledWith({
      sinceMs: 1_778_620_123_456,
      limit: 1_000,
    });
    expect(result.sinceMs).toBe(1_778_620_123_456);
  });
});
