import { describe, expect, it } from 'vitest';
import {
  roundAverage,
  syncPromotionsFromBench,
  usdToMicrodollars,
  type PromotionStore,
} from './sync.js';
import { unprefixKiloGatewayModelId } from '@kilocode/worker-utils/kilo-model-id';
import type {
  KiloBenchBenchmarks,
  LatestPromotion,
  ModelStatsTarget,
  PromotionRecord,
  PromotionTuple,
} from './types.js';

function modelStatsTargetCandidates(model: string): string[] {
  const unprefixedModel = unprefixKiloGatewayModelId(model);
  return unprefixedModel ? [model, unprefixedModel] : [model];
}

class MemoryPromotionStore implements PromotionStore {
  readonly rows = new Map<string, { promotion: PromotionRecord; modelStatsId: string | null }>();
  readonly cache = new Map<string, KiloBenchBenchmarks>();
  readonly modelStats = new Map<string, ModelStatsTarget>();

  constructor(models: ModelStatsTarget[]) {
    for (const model of models) this.modelStats.set(model.model, model);
  }

  async getLatestPromotedAtMs(): Promise<number> {
    let latest = 0;
    for (const row of this.rows.values()) latest = Math.max(latest, row.promotion.promoted_at);
    return latest;
  }

  async findModelStatsTargets(models: string[]): Promise<Map<string, ModelStatsTarget>> {
    return new Map(
      models.flatMap(model => {
        let target: ModelStatsTarget | undefined;
        for (const candidate of modelStatsTargetCandidates(model)) {
          target = this.modelStats.get(candidate);
          if (target) break;
        }
        return target ? [[model, target]] : [];
      })
    );
  }

  async insertPromotions(
    promotions: Array<{ promotion: PromotionRecord; modelStatsId: string | null }>
  ): Promise<Set<string>> {
    const inserted = new Set<string>();
    for (const { promotion, modelStatsId } of promotions) {
      if (this.rows.has(promotion.bench_eval_name)) continue;
      this.rows.set(promotion.bench_eval_name, { promotion, modelStatsId });
      inserted.add(promotion.bench_eval_name);
    }
    return inserted;
  }

  async refreshPromotion({
    promotion,
    modelStatsId,
  }: {
    promotion: PromotionRecord;
    modelStatsId: string | null;
  }): Promise<void> {
    if (!this.rows.has(promotion.bench_eval_name)) return;
    this.rows.set(promotion.bench_eval_name, { promotion, modelStatsId });
  }

  async listLatestPromotions(
    tuple: Omit<PromotionTuple, 'modelStatsId'>
  ): Promise<LatestPromotion[]> {
    const rows = [...this.rows.values()]
      .map(row => row.promotion)
      .filter(
        promotion =>
          promotion.provider === tuple.provider &&
          promotion.model === tuple.model &&
          promotion.variant === tuple.variant
      )
      .sort((left, right) => right.promoted_at - left.promoted_at);

    const latestByTask = new Map<string, LatestPromotion>();
    for (const promotion of rows) {
      if (latestByTask.has(promotion.task_source)) continue;
      latestByTask.set(promotion.task_source, {
        taskSource: promotion.task_source,
        totalScore: promotion.total_score,
        overallScore: promotion.overall_score,
        avgCostMicrodollars: usdToMicrodollars(promotion.avg_cost_usd),
        avgInputTokens: roundAverage(promotion.avg_input_tokens),
        avgOutputTokens: roundAverage(promotion.avg_output_tokens),
        avgCacheReadTokens: roundAverage(promotion.avg_cache_read_tokens),
        avgExecutionMs: roundAverage(promotion.avg_execution_ms),
        nTotalTrials: promotion.n_total_trials,
        nAttempts: promotion.n_attempts ?? null,
        totalCostMicrodollars: usdToMicrodollars(promotion.total_cost_usd ?? null),
        totalInputTokens: roundAverage(promotion.total_input_tokens ?? null),
        totalOutputTokens: roundAverage(promotion.total_output_tokens ?? null),
        totalCacheReadTokens: roundAverage(promotion.total_cache_read_tokens ?? null),
        nErrored: promotion.n_errored,
        promotedAt: new Date(promotion.promoted_at).toISOString(),
      });
    }

    return [...latestByTask.values()];
  }

  async writeKiloBenchBenchmarks(
    modelStatsId: string,
    benchmarks: KiloBenchBenchmarks
  ): Promise<void> {
    this.cache.set(modelStatsId, benchmarks);
  }
}

class MemoryBenchDashboard {
  constructor(private readonly promotions: PromotionRecord[]) {}

  async listPromotions(opts?: { sinceMs?: number; limit?: number }): Promise<PromotionRecord[]> {
    const sinceMs = opts?.sinceMs ?? 0;
    const limit = opts?.limit ?? this.promotions.length;
    return this.promotions
      .filter(promotion => promotion.promoted_at >= sinceMs)
      .sort((left, right) => left.promoted_at - right.promoted_at)
      .slice(0, limit);
  }

  async getPromotion(name: string): Promise<PromotionRecord | null> {
    return this.promotions.find(promotion => promotion.bench_eval_name === name) ?? null;
  }
}

describe('syncPromotionsFromBench', () => {
  it('ingests an empty cloud store and preserves fractional promotion scores', async () => {
    const store = createStore();
    const bench = new MemoryBenchDashboard([
      promotion({
        bench_eval_name: 'fractional-terminal',
        task_source: 'terminal-bench',
        total_score: 1.5,
        overall_score: 0.375,
        n_total_trials: 4,
      }),
      promotion({
        bench_eval_name: 'swebench-latest',
        task_source: 'swebench-verified',
        total_score: 3,
        overall_score: 0.75,
        n_total_trials: 4,
        promoted_at: Date.parse('2026-05-14T11:00:00.000Z'),
      }),
    ]);

    const result = await syncPromotionsFromBench(bench, store);

    expect(result).toEqual({ inserted: 2, alreadyHad: 0, cacheRecomputes: 1, fetched: 2 });
    expect(store.rows.size).toBe(2);
    const cache = store.cache.get('model-stats-1');
    expect(cache?.evals['terminal-bench']).toMatchObject({
      totalScore: 1.5,
      overallScore: 0.375,
      avgCostUsd: 0.25,
      avgInputTokens: 101,
      avgOutputTokens: 50,
      avgCacheReadTokens: 10,
      avgExecutionMs: 251,
      nTotalTrials: 4,
      nAttempts: 2,
      avgAttemptCostUsd: 0.5,
      avgAttemptInputTokens: 202,
      avgAttemptOutputTokens: 100,
      avgAttemptCacheReadTokens: 20,
    });
    expect(cache?.overallScore).toBe(0.5625);
  });

  it('joins kilo-prefixed promotion models to unprefixed model stats targets', async () => {
    const store = new MemoryPromotionStore([
      { id: 'model-stats-openrouter', model: 'openai/gpt-5.5' },
    ]);
    const bench = new MemoryBenchDashboard([promotion({ bench_eval_name: 'prefixed-model' })]);

    const result = await syncPromotionsFromBench(bench, store);

    expect(result).toEqual({ inserted: 1, alreadyHad: 0, cacheRecomputes: 1, fetched: 1 });
    expect(store.rows.get('prefixed-model')?.modelStatsId).toBe('model-stats-openrouter');
    expect(store.cache.get('model-stats-openrouter')?.evals['terminal-bench']).toBeDefined();
  });

  it('joins gateway-prefixed Kilo provider models to their model stats targets', async () => {
    const store = new MemoryPromotionStore([
      { id: 'model-stats-kilo-provider', model: 'kilo/special-model' },
    ]);
    const bench = new MemoryBenchDashboard([
      promotion({
        bench_eval_name: 'prefixed-kilo-provider-model',
        model: 'kilo/kilo/special-model',
      }),
    ]);

    const result = await syncPromotionsFromBench(bench, store);

    expect(result).toEqual({ inserted: 1, alreadyHad: 0, cacheRecomputes: 1, fetched: 1 });
    expect(store.rows.get('prefixed-kilo-provider-model')?.modelStatsId).toBe(
      'model-stats-kilo-provider'
    );
    expect(store.cache.get('model-stats-kilo-provider')?.evals['terminal-bench']).toBeDefined();
  });

  it('does not strip a single Kilo provider prefix into a bare model id', async () => {
    const store = new MemoryPromotionStore([{ id: 'model-stats-bare', model: 'special-model' }]);
    const bench = new MemoryBenchDashboard([
      promotion({ bench_eval_name: 'single-kilo-provider-model', model: 'kilo/special-model' }),
    ]);

    const result = await syncPromotionsFromBench(bench, store);

    expect(result).toEqual({ inserted: 1, alreadyHad: 0, cacheRecomputes: 0, fetched: 1 });
    expect(store.rows.get('single-kilo-provider-model')?.modelStatsId).toBeNull();
    expect(store.cache.size).toBe(0);
  });

  it('does not duplicate rows on an idempotent rerun', async () => {
    const store = createStore();
    const bench = new MemoryBenchDashboard([promotion({ bench_eval_name: 'idempotent-row' })]);

    await syncPromotionsFromBench(bench, store);
    const rerun = await syncPromotionsFromBench(bench, store);

    expect(store.rows.size).toBe(1);
    expect(rerun.inserted).toBe(0);
    expect(rerun.alreadyHad).toBe(1);
    expect(rerun.cacheRecomputes).toBe(0);
  });

  it('refreshes attempt metrics on an explicit admin re-pull of an existing promotion', async () => {
    const store = createStore();
    const initialBench = new MemoryBenchDashboard([
      promotion({
        bench_eval_name: 'repull-row',
        n_attempts: undefined,
        total_cost_usd: undefined,
        total_input_tokens: undefined,
        total_output_tokens: undefined,
        total_cache_read_tokens: undefined,
      }),
    ]);

    await syncPromotionsFromBench(initialBench, store);
    expect(store.cache.get('model-stats-1')?.evals['terminal-bench'].avgAttemptCostUsd).toBeNull();

    const enrichedBench = new MemoryBenchDashboard([
      promotion({ bench_eval_name: 'repull-row', n_attempts: 5, total_cost_usd: 500 }),
    ]);
    const repull = await syncPromotionsFromBench(enrichedBench, store, {
      promotionName: 'repull-row',
    });

    expect(repull.inserted).toBe(0);
    expect(repull.alreadyHad).toBe(1);
    expect(repull.cacheRecomputes).toBe(1);
    expect(store.cache.get('model-stats-1')?.evals['terminal-bench'].avgAttemptCostUsd).toBe(100);
  });

  it('uses the latest promoted task row and excludes audit-only promotion details from cache', async () => {
    const store = createStore();
    const bench = new MemoryBenchDashboard([
      promotion({
        bench_eval_name: 'old-terminal',
        task_source: 'terminal-bench',
        total_score: 1,
        overall_score: 0.25,
        promoted_at: Date.parse('2026-05-14T09:00:00.000Z'),
      }),
      promotion({
        bench_eval_name: 'new-terminal',
        task_source: 'terminal-bench',
        total_score: 1.5,
        overall_score: 0.375,
        promoted_at: Date.parse('2026-05-14T10:00:00.000Z'),
      }),
    ]);

    await syncPromotionsFromBench(bench, store);

    const cache = store.cache.get('model-stats-1');
    expect(cache?.evals['terminal-bench']).toMatchObject({
      totalScore: 1.5,
      overallScore: 0.375,
      lastPromotedAt: '2026-05-14T10:00:00.000Z',
    });
    expect(JSON.stringify(cache)).not.toContain('bench.example.com');
    expect(JSON.stringify(cache)).not.toContain('promoter@example.com');
    expect(JSON.stringify(cache)).not.toContain('new-terminal');
  });
});

function createStore(): MemoryPromotionStore {
  return new MemoryPromotionStore([{ id: 'model-stats-1', model: 'kilo/openai/gpt-5.5' }]);
}

function promotion(overrides: Partial<PromotionRecord>): PromotionRecord {
  return {
    bench_eval_name: 'bench-promotion',
    bench_eval_url: 'https://bench.example.com/jobs/bench-promotion',
    provider: 'kilo',
    model: 'kilo/openai/gpt-5.5',
    variant: null,
    task_source: 'terminal-bench',
    n_total_trials: 4,
    n_attempts: 2,
    total_score: 2,
    overall_score: 0.5,
    n_errored: 0,
    avg_cost_usd: 0.25,
    total_cost_usd: 1,
    avg_input_tokens: 100.5,
    total_input_tokens: 404,
    avg_output_tokens: 50.25,
    total_output_tokens: 200,
    avg_cache_read_tokens: 10.125,
    total_cache_read_tokens: 40,
    avg_execution_ms: 250.75,
    promoted_at: Date.parse('2026-05-14T10:00:00.000Z'),
    promoted_by_email: 'promoter@example.com',
    promotion_note: null,
    ...overrides,
  };
}
