import { z } from 'zod';
import type { ProdMetrics, ShadowMetrics } from './schema';

type ClassifiedDecisionGroup = {
  n: number;
  sampled: boolean;
  route: string;
  cacheHit: boolean | null;
  cost: number | null;
};

export function estimateClassifiedMetrics(
  groups: readonly ClassifiedDecisionGroup[],
  sampleRate: number
) {
  const sampledWeight = sampleRate > 0 ? 1 / sampleRate : 0;
  let classifiedCount = 0;
  let cacheCount = 0;
  let cacheHits = 0;
  let costCount = 0;
  let costTotal = 0;
  const routeCounts: Record<string, number> = {};
  for (const group of groups) {
    const weightedCount = group.n * (group.sampled ? sampledWeight : 1);
    classifiedCount += weightedCount;
    routeCounts[group.route] = (routeCounts[group.route] ?? 0) + weightedCount;
    if (group.cacheHit !== null) {
      cacheCount += weightedCount;
      if (group.cacheHit) cacheHits += weightedCount;
    }
    if (group.cost !== null) {
      costCount += weightedCount;
      costTotal += group.cost * weightedCount;
    }
  }
  return {
    cacheHitRate: cacheCount ? cacheHits / cacheCount : null,
    classifierPerRequestUsd: costCount ? costTotal / costCount : null,
    routeMix: classifiedCount
      ? Object.fromEntries(
          Object.entries(routeCounts).map(([route, n]) => [route, n / classifiedCount])
        )
      : {},
  };
}

export const ShadowDecisionGroupSchema = z.object({
  n: z.number().int().nonnegative(),
  sampled: z.boolean(),
  differs: z.boolean(),
  sessionId: z.string().nullable(),
  decidedModel: z.string().nullable(),
});
type ShadowDecisionGroup = z.infer<typeof ShadowDecisionGroupSchema>;

export function estimateShadowMetrics(
  groups: readonly ShadowDecisionGroup[],
  sampleRate: number
): ShadowMetrics {
  let observedDecisions = 0;
  let decisions = 0;
  let differs = 0;
  for (const group of groups) {
    observedDecisions += group.n;
    const weightedCount = group.n * (group.sampled ? (sampleRate > 0 ? 1 / sampleRate : 0) : 1);
    decisions += weightedCount;
    if (group.differs) differs += weightedCount;
  }
  return {
    observedDecisions,
    differsRate: sampleRate > 0 && decisions > 0 ? differs / decisions : null,
    outcomesByDecidedModel: null,
  };
}

export function shadowOutcomesQuery(
  window: ProdMetrics['window'],
  groups: readonly ShadowDecisionGroup[]
): string {
  const pairs = groups
    .filter(group => group.sessionId && group.decidedModel)
    .map(({ sessionId, decidedModel }) => ({ sessionId, decidedModel }));
  const cohort = JSON.stringify(pairs).replaceAll("'", "''");
  const start = window.start.replaceAll("'", "''");
  const end = window.end.replaceAll("'", "''");
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout='55s';
SET LOCAL standard_conforming_strings=on;
WITH decisions AS (
  SELECT DISTINCT "sessionId", "decidedModel"
  FROM jsonb_to_recordset('${cohort}'::jsonb) AS d("sessionId" text, "decidedModel" text)
), outcomes AS (
  SELECT
    d."decidedModel" AS model,
    count(*) AS requests,
    avg((meta.status_code >= 400)::int)::double precision AS "errorRate",
    avg(meta.cancelled::int)::double precision AS "abortRate",
    avg(usage.input_tokens)::double precision AS "inputTokensPerRequest",
    avg(usage.output_tokens)::double precision AS "outputTokensPerRequest",
    avg(usage.cache_hit_tokens)::double precision AS "cacheReadTokensPerRequest",
    avg(usage.cost)::double precision / 1000000 AS "costUsdPerRequest"
  FROM decisions d
  JOIN microdollar_usage_metadata meta ON meta.session_id = d."sessionId"
  JOIN microdollar_usage usage ON usage.id = meta.id AND usage.model = d."decidedModel"
  JOIN auto_model am ON am.auto_model_id = meta.auto_model_id
  WHERE am.auto_model IN ('kilo-auto/efficient', 'kilo-auto/balanced')
    AND meta.created_at >= '${start}'::timestamptz
    AND meta.created_at < '${end}'::timestamptz
    AND usage.created_at >= '${start}'::timestamptz
    AND usage.created_at < '${end}'::timestamptz
  GROUP BY d."decidedModel"
)
SELECT coalesce(jsonb_object_agg(model, to_jsonb(outcomes) - 'model'), '{}'::jsonb) AS shadow_outcomes
FROM outcomes;
ROLLBACK;`;
}
