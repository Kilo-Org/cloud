import {
  estimateRequestCostUsd,
  poolEntryKey,
  rankCandidates,
  type ProductionTokenProfile,
} from '@kilocode/auto-routing-contracts';
import type { ProdMetrics, ReplayMetrics, Scoreboard, ScoreboardRoutingTable } from './schema';

type BuildScoreboardInput = {
  label: string;
  table: ScoreboardRoutingTable;
  classifierRouteAccuracy: number | null;
  prod: ProdMetrics | null;
  replay: ReplayMetrics | null;
  now: Date;
  rerankProfile?: ProductionTokenProfile | null;
  costProfile?: ProductionTokenProfile | null;
};

export function buildScoreboard({
  label,
  table,
  classifierRouteAccuracy,
  prod,
  replay,
  now,
  rerankProfile = null,
  costProfile,
}: BuildScoreboardInput): Scoreboard {
  const profile = costProfile ?? rerankProfile ?? table.productionTokenProfile ?? null;
  const routes = rerankProfile
    ? Object.fromEntries(
        Object.entries(table.routes).map(([route, candidates]) => {
          const key = (candidate: (typeof candidates)[number]) =>
            poolEntryKey({
              model: candidate.model,
              variant: candidate.variant ?? candidate.reasoningEffort ?? null,
            });
          const latencies = Object.fromEntries(
            candidates.map(candidate => [key(candidate), candidate.p50LatencyMs])
          );
          const ranked = rankCandidates(
            candidates.map(candidate => ({
              ...candidate,
              p50LatencyMs: candidate.p50LatencyMs ?? null,
            })),
            table.minAccuracy,
            { profile: rerankProfile }
          ).map(candidate => ({ ...candidate, p50LatencyMs: latencies[key(candidate)] }));
          return [route, ranked];
        })
      )
    : table.routes;
  const routeKeys = Object.keys(table.routes);
  const routeMix =
    prod && Object.keys(prod.routeMix).length > 0
      ? prod.routeMix
      : Object.fromEntries(routeKeys.map(key => [key, 1 / routeKeys.length]));
  const weighted = (
    metric: 'accuracy' | 'avgCostUsd' | 'p50LatencyMs' | 'estimatedRequestCostUsd'
  ): number | null => {
    let total = 0;
    let weight = 0;
    for (const [route, share] of Object.entries(routeMix)) {
      const candidate = routes[route]?.[0];
      if (!candidate || share <= 0) continue;
      if (metric === 'estimatedRequestCostUsd' && !candidate.pricing) return null;
      const value =
        metric === 'estimatedRequestCostUsd'
          ? estimateRequestCostUsd(candidate, profile)
          : candidate[metric];
      if (value == null) continue;
      total += share * value;
      weight += share;
    }
    return weight > 0 ? total / weight : null;
  };

  return {
    version: 1,
    label,
    generatedAt: now.toISOString(),
    latency: {
      routerOverheadMs: {
        gateway: prod?.gatewayDecideMs ?? null,
        worker: prod?.workerDecideMs ?? null,
        replay: replay?.scenarios ?? null,
      },
      workerPhasesMs: prod?.workerPhasesMs ?? null,
      cacheHitRate: prod?.cacheHitRate ?? null,
      modelTtftMs: {
        prod: prod?.modelTtftMs ?? null,
        benchmarkP50Weighted: weighted('p50LatencyMs'),
      },
    },
    cost: {
      prodPerRequestUsd: prod?.prodPerRequestUsd ?? { mean: null, p50: null },
      prodCacheReadShare: prod?.prodCacheReadShare ?? null,
      classifierPerRequestUsd: prod?.classifierPerRequestUsd ?? null,
      switchRate: prod?.switchRate ?? null,
      benchmarkPerTaskUsdWeighted: weighted('avgCostUsd'),
      estimatedRequestUsdWeighted: weighted('estimatedRequestCostUsd'),
    },
    quality: {
      benchmarkAccuracyWeighted: weighted('accuracy'),
      classifierRouteAccuracy,
      heldOut: null,
    },
    routeMix,
  };
}
