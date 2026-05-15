import type { WorkerDb } from '@kilocode/db/client';
import { model_eval_ingest, modelStats } from '@kilocode/db/schema';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  PromotionRecordSchema,
  type KiloBenchBenchmarks,
  type LatestPromotion,
  type ModelStatsTarget,
  type PromotionRecord,
  type PromotionTuple,
  type SyncResult,
} from './types.js';

const PROMOTION_PULL_LIMIT = 1000;

type BenchDashboard = {
  listPromotions(opts?: { sinceMs?: number; limit?: number }): Promise<PromotionRecord[]>;
  getPromotion(name: string): Promise<PromotionRecord | null>;
};

type PromotionInsert = {
  promotion: PromotionRecord;
  modelStatsId: string | null;
};

export type PromotionStore = {
  getLatestPromotedAtMs(): Promise<number>;
  findModelStatsTargets(models: string[]): Promise<Map<string, ModelStatsTarget>>;
  insertPromotions(promotions: PromotionInsert[]): Promise<Set<string>>;
  listLatestPromotions(tuple: Omit<PromotionTuple, 'modelStatsId'>): Promise<LatestPromotion[]>;
  writeKiloBenchBenchmarks(modelStatsId: string, benchmarks: KiloBenchBenchmarks): Promise<void>;
};

export function createPromotionStore(db: WorkerDb): PromotionStore {
  return {
    async getLatestPromotedAtMs(): Promise<number> {
      const [latest] = await db
        .select({ promotedAt: model_eval_ingest.promoted_at })
        .from(model_eval_ingest)
        .orderBy(desc(model_eval_ingest.promoted_at))
        .limit(1);

      return latest ? Date.parse(latest.promotedAt) : 0;
    },

    async findModelStatsTargets(models: string[]): Promise<Map<string, ModelStatsTarget>> {
      if (models.length === 0) return new Map();

      const targets = await db
        .select({ id: modelStats.id, model: modelStats.openrouterId })
        .from(modelStats)
        .where(inArray(modelStats.openrouterId, models));

      return new Map(targets.map(target => [target.model, target]));
    },

    async insertPromotions(promotions: PromotionInsert[]): Promise<Set<string>> {
      if (promotions.length === 0) return new Set();

      const inserted = await db
        .insert(model_eval_ingest)
        .values(
          promotions.map(({ promotion, modelStatsId }) => ({
            bench_eval_name: promotion.bench_eval_name,
            bench_eval_url: promotion.bench_eval_url,
            provider: promotion.provider,
            model: promotion.model,
            model_stats_id: modelStatsId,
            variant: promotion.variant,
            task_source: promotion.task_source,
            n_total_trials: promotion.n_total_trials,
            total_score: promotion.total_score,
            overall_score: promotion.overall_score,
            n_errored: promotion.n_errored,
            avg_cost_usd: promotion.avg_cost_usd,
            avg_input_tokens: promotion.avg_input_tokens,
            avg_output_tokens: promotion.avg_output_tokens,
            avg_cache_read_tokens: promotion.avg_cache_read_tokens,
            avg_execution_ms: promotion.avg_execution_ms,
            promoted_at: new Date(promotion.promoted_at).toISOString(),
            promoted_by_email: promotion.promoted_by_email,
            promotion_note: promotion.promotion_note,
          }))
        )
        .onConflictDoNothing({ target: model_eval_ingest.bench_eval_name })
        .returning({ benchEvalName: model_eval_ingest.bench_eval_name });

      return new Set(inserted.map(row => row.benchEvalName));
    },

    async listLatestPromotions(
      tuple: Omit<PromotionTuple, 'modelStatsId'>
    ): Promise<LatestPromotion[]> {
      const variantCondition =
        tuple.variant === null
          ? isNull(model_eval_ingest.variant)
          : eq(model_eval_ingest.variant, tuple.variant);
      const rows = await db
        .select({
          taskSource: model_eval_ingest.task_source,
          totalScore: model_eval_ingest.total_score,
          overallScore: model_eval_ingest.overall_score,
          avgCostUsd: model_eval_ingest.avg_cost_usd,
          avgInputTokens: model_eval_ingest.avg_input_tokens,
          avgOutputTokens: model_eval_ingest.avg_output_tokens,
          avgCacheReadTokens: model_eval_ingest.avg_cache_read_tokens,
          avgExecutionMs: model_eval_ingest.avg_execution_ms,
          nTotalTrials: model_eval_ingest.n_total_trials,
          nErrored: model_eval_ingest.n_errored,
          promotedAt: model_eval_ingest.promoted_at,
        })
        .from(model_eval_ingest)
        .where(
          and(
            eq(model_eval_ingest.provider, tuple.provider),
            eq(model_eval_ingest.model, tuple.model),
            variantCondition
          )
        )
        .orderBy(desc(model_eval_ingest.promoted_at), desc(model_eval_ingest.bench_eval_name));

      const latestByTaskSource = new Map<string, LatestPromotion>();
      for (const row of rows) {
        if (!latestByTaskSource.has(row.taskSource)) {
          latestByTaskSource.set(row.taskSource, row);
        }
      }

      return [...latestByTaskSource.values()];
    },

    async writeKiloBenchBenchmarks(
      modelStatsId: string,
      benchmarks: KiloBenchBenchmarks
    ): Promise<void> {
      await db
        .update(modelStats)
        .set({
          benchmarks: sql`
            COALESCE(${modelStats.benchmarks}, '{}'::jsonb) ||
            ${JSON.stringify({ kiloBench: benchmarks })}::jsonb
          `,
        })
        .where(eq(modelStats.id, modelStatsId));
    },
  };
}

export function buildKiloBenchBenchmarks(rows: LatestPromotion[]): KiloBenchBenchmarks {
  let totalScore = 0;
  let nTotalTrials = 0;
  const evals: KiloBenchBenchmarks['evals'] = {};

  for (const row of rows) {
    totalScore += row.totalScore;
    nTotalTrials += row.nTotalTrials;
    evals[row.taskSource] = {
      taskSource: row.taskSource,
      overallScore: row.overallScore,
      totalScore: row.totalScore,
      avgCostUsd: row.avgCostUsd,
      avgInputTokens: row.avgInputTokens,
      avgOutputTokens: row.avgOutputTokens,
      avgCacheReadTokens: row.avgCacheReadTokens,
      avgExecutionMs: row.avgExecutionMs,
      nTotalTrials: row.nTotalTrials,
      nErrored: row.nErrored,
      lastPromotedAt: new Date(row.promotedAt).toISOString(),
    };
  }

  return {
    overallScore: nTotalTrials > 0 ? totalScore / nTotalTrials : 0,
    evals,
  };
}

export async function recomputeModelStatsKiloBench(
  store: PromotionStore,
  tuple: PromotionTuple
): Promise<void> {
  const rows = await store.listLatestPromotions({
    provider: tuple.provider,
    model: tuple.model,
    variant: tuple.variant,
  });
  await store.writeKiloBenchBenchmarks(tuple.modelStatsId, buildKiloBenchBenchmarks(rows));
}

export async function syncPromotionsFromBench(
  benchDashboard: BenchDashboard,
  store: PromotionStore,
  opts: { promotionName?: string } = {}
): Promise<SyncResult> {
  const rawPromotions = opts.promotionName
    ? await getNamedPromotion(benchDashboard, opts.promotionName)
    : await listNewPromotions(benchDashboard, store);
  const promotions = rawPromotions.map(promotion => PromotionRecordSchema.parse(promotion));

  let inserted = 0;
  let alreadyHad = 0;
  const tuplesToRecompute = new Map<string, PromotionTuple>();
  const modelStatsTargets = await store.findModelStatsTargets([
    ...new Set(promotions.map(promotion => promotion.model)),
  ]);
  const promotionsToInsert = promotions.map(promotion => {
    const modelStatsTarget = modelStatsTargets.get(promotion.model);
    return {
      promotion,
      modelStatsId: modelStatsTarget?.id ?? null,
    } satisfies PromotionInsert;
  });
  const insertedPromotionNames = await store.insertPromotions(promotionsToInsert);

  for (const promotion of promotions) {
    const modelStatsTarget = modelStatsTargets.get(promotion.model);
    const wasInserted = insertedPromotionNames.has(promotion.bench_eval_name);
    if (wasInserted) {
      inserted++;
    } else {
      alreadyHad++;
    }

    if (modelStatsTarget && (wasInserted || opts.promotionName != null)) {
      const tuple = {
        provider: promotion.provider,
        model: promotion.model,
        variant: promotion.variant,
        modelStatsId: modelStatsTarget.id,
      } satisfies PromotionTuple;
      tuplesToRecompute.set(tupleKey(tuple), tuple);
    }
  }

  for (const tuple of tuplesToRecompute.values()) {
    await recomputeModelStatsKiloBench(store, tuple);
  }

  return {
    inserted,
    alreadyHad,
    cacheRecomputes: tuplesToRecompute.size,
    fetched: promotions.length,
  };
}

async function listNewPromotions(
  benchDashboard: BenchDashboard,
  store: PromotionStore
): Promise<PromotionRecord[]> {
  const sinceMs = await store.getLatestPromotedAtMs();
  return benchDashboard.listPromotions({ sinceMs, limit: PROMOTION_PULL_LIMIT });
}

async function getNamedPromotion(
  benchDashboard: BenchDashboard,
  promotionName: string
): Promise<PromotionRecord[]> {
  const promotion = await benchDashboard.getPromotion(promotionName);
  return promotion ? [promotion] : [];
}

function tupleKey(tuple: PromotionTuple): string {
  return `${tuple.provider}\u0000${tuple.model}\u0000${tuple.variant ?? ''}\u0000${tuple.modelStatsId}`;
}
