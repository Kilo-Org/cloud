import type { WorkerDb } from '@kilocode/db/client';
import { model_eval_ingestions, modelStats } from '@kilocode/db/schema';
import { unprefixKiloGatewayModelId } from '@kilocode/worker-utils/kilo-model-id';
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
const MICRODOLLARS_PER_DOLLAR = 1_000_000;

export function usdToMicrodollars(value: number | null): number | null {
  return value === null ? null : Math.round(value * MICRODOLLARS_PER_DOLLAR);
}

export function roundAverage(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function microdollarsToUsd(value: number | null): number | null {
  return value === null ? null : value / MICRODOLLARS_PER_DOLLAR;
}

function averagePerAttempt(total: number | null, nAttempts: number | null): number | null {
  return total === null || nAttempts === null || nAttempts <= 0 ? null : total / nAttempts;
}

type BenchDashboard = {
  listPromotions(opts?: { sinceMs?: number; limit?: number }): Promise<PromotionRecord[]>;
  getPromotion(name: string): Promise<PromotionRecord | null>;
};

type PromotionInsert = {
  promotion: PromotionRecord;
  modelStatsId: string | null;
};

function storedPromotionValues({ promotion, modelStatsId }: PromotionInsert) {
  return {
    bench_eval_url: promotion.bench_eval_url,
    provider: promotion.provider,
    model: promotion.model,
    model_stats_id: modelStatsId,
    variant: promotion.variant,
    task_source: promotion.task_source,
    n_total_trials: promotion.n_total_trials,
    n_attempts: promotion.n_attempts ?? null,
    total_score: promotion.total_score,
    overall_score: promotion.overall_score,
    n_errored: promotion.n_errored,
    avg_cost_microdollars: usdToMicrodollars(promotion.avg_cost_usd),
    total_cost_microdollars: usdToMicrodollars(promotion.total_cost_usd ?? null),
    avg_input_tokens: roundAverage(promotion.avg_input_tokens),
    total_input_tokens: roundAverage(promotion.total_input_tokens ?? null),
    avg_output_tokens: roundAverage(promotion.avg_output_tokens),
    total_output_tokens: roundAverage(promotion.total_output_tokens ?? null),
    avg_cache_read_tokens: roundAverage(promotion.avg_cache_read_tokens),
    total_cache_read_tokens: roundAverage(promotion.total_cache_read_tokens ?? null),
    avg_execution_ms: roundAverage(promotion.avg_execution_ms),
    promoted_at: new Date(promotion.promoted_at).toISOString(),
    promoted_by_email: promotion.promoted_by_email,
    promotion_note: promotion.promotion_note,
  };
}

export type PromotionStore = {
  getLatestPromotedAtMs(): Promise<number>;
  findModelStatsTargets(models: string[]): Promise<Map<string, ModelStatsTarget>>;
  insertPromotions(promotions: PromotionInsert[]): Promise<Set<string>>;
  refreshPromotion(promotion: PromotionInsert): Promise<void>;
  listLatestPromotions(tuple: Omit<PromotionTuple, 'modelStatsId'>): Promise<LatestPromotion[]>;
  writeKiloBenchBenchmarks(modelStatsId: string, benchmarks: KiloBenchBenchmarks): Promise<void>;
};

function modelStatsTargetCandidates(model: string): string[] {
  const unprefixedModel = unprefixKiloGatewayModelId(model);
  return unprefixedModel ? [model, unprefixedModel] : [model];
}

export function createPromotionStore(db: WorkerDb): PromotionStore {
  return {
    async getLatestPromotedAtMs(): Promise<number> {
      const [latest] = await db
        .select({ promotedAt: model_eval_ingestions.promoted_at })
        .from(model_eval_ingestions)
        .orderBy(desc(model_eval_ingestions.promoted_at))
        .limit(1);

      return latest ? Date.parse(latest.promotedAt) : 0;
    },

    async findModelStatsTargets(models: string[]): Promise<Map<string, ModelStatsTarget>> {
      const promotionModels = [...new Set(models)];
      if (promotionModels.length === 0) return new Map();

      const lookupModels = new Set<string>();
      for (const model of promotionModels) {
        for (const candidate of modelStatsTargetCandidates(model)) lookupModels.add(candidate);
      }

      const targets = await db
        .select({ id: modelStats.id, model: modelStats.openrouterId })
        .from(modelStats)
        .where(inArray(modelStats.openrouterId, [...lookupModels]));
      const targetsByModel = new Map(targets.map(target => [target.model, target]));
      const resolvedTargets = new Map<string, ModelStatsTarget>();

      for (const model of promotionModels) {
        for (const candidate of modelStatsTargetCandidates(model)) {
          const target = targetsByModel.get(candidate);
          if (!target) continue;
          resolvedTargets.set(model, target);
          break;
        }
      }

      return resolvedTargets;
    },

    async insertPromotions(promotions: PromotionInsert[]): Promise<Set<string>> {
      if (promotions.length === 0) return new Set();

      const inserted = await db
        .insert(model_eval_ingestions)
        .values(
          promotions.map(promotion => ({
            bench_eval_name: promotion.promotion.bench_eval_name,
            ...storedPromotionValues(promotion),
          }))
        )
        .onConflictDoNothing({ target: model_eval_ingestions.bench_eval_name })
        .returning({ benchEvalName: model_eval_ingestions.bench_eval_name });

      return new Set(inserted.map(row => row.benchEvalName));
    },

    async refreshPromotion(promotion: PromotionInsert): Promise<void> {
      await db
        .update(model_eval_ingestions)
        .set(storedPromotionValues(promotion))
        .where(eq(model_eval_ingestions.bench_eval_name, promotion.promotion.bench_eval_name));
    },

    async listLatestPromotions(
      tuple: Omit<PromotionTuple, 'modelStatsId'>
    ): Promise<LatestPromotion[]> {
      const variantCondition =
        tuple.variant === null
          ? isNull(model_eval_ingestions.variant)
          : eq(model_eval_ingestions.variant, tuple.variant);
      const rows = await db
        .select({
          taskSource: model_eval_ingestions.task_source,
          totalScore: model_eval_ingestions.total_score,
          overallScore: model_eval_ingestions.overall_score,
          avgCostMicrodollars: model_eval_ingestions.avg_cost_microdollars,
          avgInputTokens: model_eval_ingestions.avg_input_tokens,
          avgOutputTokens: model_eval_ingestions.avg_output_tokens,
          avgCacheReadTokens: model_eval_ingestions.avg_cache_read_tokens,
          avgExecutionMs: model_eval_ingestions.avg_execution_ms,
          nTotalTrials: model_eval_ingestions.n_total_trials,
          nAttempts: model_eval_ingestions.n_attempts,
          totalCostMicrodollars: model_eval_ingestions.total_cost_microdollars,
          totalInputTokens: model_eval_ingestions.total_input_tokens,
          totalOutputTokens: model_eval_ingestions.total_output_tokens,
          totalCacheReadTokens: model_eval_ingestions.total_cache_read_tokens,
          nErrored: model_eval_ingestions.n_errored,
          promotedAt: model_eval_ingestions.promoted_at,
        })
        .from(model_eval_ingestions)
        .where(
          and(
            eq(model_eval_ingestions.provider, tuple.provider),
            eq(model_eval_ingestions.model, tuple.model),
            variantCondition
          )
        )
        .orderBy(
          desc(model_eval_ingestions.promoted_at),
          desc(model_eval_ingestions.bench_eval_name)
        );

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
      avgCostUsd: microdollarsToUsd(row.avgCostMicrodollars),
      avgInputTokens: row.avgInputTokens,
      avgOutputTokens: row.avgOutputTokens,
      avgCacheReadTokens: row.avgCacheReadTokens,
      avgExecutionMs: row.avgExecutionMs,
      nTotalTrials: row.nTotalTrials,
      nAttempts: row.nAttempts,
      avgAttemptCostUsd: microdollarsToUsd(
        averagePerAttempt(row.totalCostMicrodollars, row.nAttempts)
      ),
      avgAttemptInputTokens: averagePerAttempt(row.totalInputTokens, row.nAttempts),
      avgAttemptOutputTokens: averagePerAttempt(row.totalOutputTokens, row.nAttempts),
      avgAttemptCacheReadTokens: averagePerAttempt(row.totalCacheReadTokens, row.nAttempts),
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
  if (opts.promotionName != null) {
    const promotionToRefresh = promotionsToInsert.find(
      ({ promotion }) => !insertedPromotionNames.has(promotion.bench_eval_name)
    );
    if (promotionToRefresh) {
      await store.refreshPromotion(promotionToRefresh);
    }
  }

  for (const promotion of promotions) {
    const modelStatsTarget = modelStatsTargets.get(promotion.model);
    const wasInserted = insertedPromotionNames.has(promotion.bench_eval_name);
    if (wasInserted) {
      inserted++;
    } else {
      alreadyHad++;
    }

    // Named admin re-pulls refresh the model cache even when the audit row is already present.
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
