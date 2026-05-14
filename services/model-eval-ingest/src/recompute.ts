import type { WorkerDb } from '@kilocode/db/client';
import {
  ModelStatsKiloBenchSchema,
  model_eval_ingest,
  modelStats,
  type ModelStatsKiloBenchEval,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';

type PromotionIdentity = {
  provider: string;
  model: string;
  variant: string | null;
};

type ModelStatsTarget = {
  id: string;
  openrouterId: string;
  usedFallback: boolean;
};

type LatestPromotionRow = {
  task_source: string;
  total_score: string;
  overall_score: string;
  n_total_trials: number;
  avg_cost_usd: string | null;
  avg_input_tokens: number | null;
  avg_output_tokens: number | null;
  avg_cache_read_tokens: number | null;
  avg_execution_ms: number | null;
  promoted_at: string;
};

function openrouterIdForIdentity(identity: PromotionIdentity): string {
  const base = `${identity.provider}/${identity.model}`;
  return identity.variant ? `${base}:${identity.variant}` : base;
}

async function findTargetModelStats(
  db: WorkerDb,
  identity: PromotionIdentity
): Promise<ModelStatsTarget | null> {
  const exactOpenrouterId = openrouterIdForIdentity(identity);
  const exactRows = await db
    .select({ id: modelStats.id, openrouterId: modelStats.openrouterId })
    .from(modelStats)
    .where(eq(modelStats.openrouterId, exactOpenrouterId))
    .limit(1);

  const exact = exactRows[0];
  if (exact) {
    return { ...exact, usedFallback: false };
  }

  if (!identity.variant) {
    return null;
  }

  const baseOpenrouterId = `${identity.provider}/${identity.model}`;
  const fallbackRows = await db
    .select({ id: modelStats.id, openrouterId: modelStats.openrouterId })
    .from(modelStats)
    .where(eq(modelStats.openrouterId, baseOpenrouterId))
    .limit(1);

  const fallback = fallbackRows[0];
  return fallback ? { ...fallback, usedFallback: true } : null;
}

async function getLatestPromotionsForTarget(
  db: WorkerDb,
  identity: PromotionIdentity,
  usedFallback: boolean
): Promise<LatestPromotionRow[]> {
  if (usedFallback) {
    const result = await db.execute<LatestPromotionRow>(sql`
      SELECT DISTINCT ON (${model_eval_ingest.task_source})
        ${model_eval_ingest.task_source} AS task_source,
        ${model_eval_ingest.total_score} AS total_score,
        ${model_eval_ingest.overall_score} AS overall_score,
        ${model_eval_ingest.n_total_trials} AS n_total_trials,
        ${model_eval_ingest.avg_cost_usd} AS avg_cost_usd,
        ${model_eval_ingest.avg_input_tokens} AS avg_input_tokens,
        ${model_eval_ingest.avg_output_tokens} AS avg_output_tokens,
        ${model_eval_ingest.avg_cache_read_tokens} AS avg_cache_read_tokens,
        ${model_eval_ingest.avg_execution_ms} AS avg_execution_ms,
        ${model_eval_ingest.promoted_at} AS promoted_at
      FROM ${model_eval_ingest}
      WHERE ${model_eval_ingest.provider} = ${identity.provider}
        AND ${model_eval_ingest.model} = ${identity.model}
      ORDER BY ${model_eval_ingest.task_source}, ${model_eval_ingest.promoted_at} DESC
    `);

    return result.rows;
  }

  const result = await db.execute<LatestPromotionRow>(sql`
    SELECT DISTINCT ON (${model_eval_ingest.task_source})
      ${model_eval_ingest.task_source} AS task_source,
      ${model_eval_ingest.total_score} AS total_score,
      ${model_eval_ingest.overall_score} AS overall_score,
      ${model_eval_ingest.n_total_trials} AS n_total_trials,
      ${model_eval_ingest.avg_cost_usd} AS avg_cost_usd,
      ${model_eval_ingest.avg_input_tokens} AS avg_input_tokens,
      ${model_eval_ingest.avg_output_tokens} AS avg_output_tokens,
      ${model_eval_ingest.avg_cache_read_tokens} AS avg_cache_read_tokens,
      ${model_eval_ingest.avg_execution_ms} AS avg_execution_ms,
      ${model_eval_ingest.promoted_at} AS promoted_at
    FROM ${model_eval_ingest}
    WHERE ${model_eval_ingest.provider} = ${identity.provider}
      AND ${model_eval_ingest.model} = ${identity.model}
      AND ${model_eval_ingest.variant} IS NOT DISTINCT FROM ${identity.variant}
    ORDER BY ${model_eval_ingest.task_source}, ${model_eval_ingest.promoted_at} DESC
  `);

  return result.rows;
}

function asNullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

export function buildKiloBenchCache(rows: LatestPromotionRow[]) {
  const evals: Record<string, ModelStatsKiloBenchEval> = {};

  for (const row of rows) {
    const evalRecord = {
      taskSource: row.task_source,
      overallScore: Number(row.overall_score),
      totalScore: Number(row.total_score),
      nTotalTrials: row.n_total_trials,
      avgCostUsd: asNullableNumber(row.avg_cost_usd),
      avgInputTokens: row.avg_input_tokens,
      avgOutputTokens: row.avg_output_tokens,
      avgCacheReadTokens: row.avg_cache_read_tokens,
      avgExecutionMs: row.avg_execution_ms,
      lastPromotedAt: row.promoted_at,
    } satisfies ModelStatsKiloBenchEval;

    const current = evals[row.task_source];
    if (!current || current.lastPromotedAt < evalRecord.lastPromotedAt) {
      evals[row.task_source] = evalRecord;
    }
  }

  const totals = Object.values(evals).reduce(
    (summary, evalRecord) => ({
      totalScore: summary.totalScore + evalRecord.totalScore,
      totalTrials: summary.totalTrials + evalRecord.nTotalTrials,
    }),
    { totalScore: 0, totalTrials: 0 }
  );

  return ModelStatsKiloBenchSchema.parse({
    overallScore: totals.totalTrials === 0 ? 0 : totals.totalScore / totals.totalTrials,
    evals,
    lastUpdated: new Date().toISOString(),
  });
}

export async function recomputeModelStatsKiloBench(
  db: WorkerDb,
  identity: PromotionIdentity
): Promise<boolean> {
  const target = await findTargetModelStats(db, identity);
  if (!target) {
    const exactOpenrouterId = openrouterIdForIdentity(identity);
    const fallbackMessage = identity.variant
      ? `, fallback=${identity.provider}/${identity.model}`
      : '';
    console.warn(
      `[model-eval-ingest] no modelStats row for exact=${exactOpenrouterId}${fallbackMessage}`
    );
    return false;
  }

  const rows = await getLatestPromotionsForTarget(db, identity, target.usedFallback);
  if (rows.length === 0) {
    return false;
  }

  const kiloBench = buildKiloBenchCache(rows);
  await db
    .update(modelStats)
    .set({
      benchmarks: sql`
        COALESCE(${modelStats.benchmarks}, '{}'::jsonb) ||
        ${JSON.stringify({ kiloBench })}::jsonb
      `,
    })
    .where(eq(modelStats.id, target.id));

  return true;
}
