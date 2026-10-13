import type { ProdMetrics, ReplayMetrics, Scoreboard, ScoreboardRoutingTable } from './schema';

type BuildScoreboardInput = {
  label: string;
  table: ScoreboardRoutingTable;
  classifierRouteAccuracy: number | null;
  prod: ProdMetrics | null;
  replay: ReplayMetrics | null;
  now: Date;
};

export function buildScoreboard({
  label,
  table,
  classifierRouteAccuracy,
  prod,
  replay,
  now,
}: BuildScoreboardInput): Scoreboard {
  const routeKeys = Object.keys(table.routes);
  const routeMix = prod?.routeMix ?? Object.fromEntries(routeKeys.map(key => [key, 1 / routeKeys.length]));
  const weighted = (metric: 'accuracy' | 'avgCostUsd' | 'p50LatencyMs'): number | null => {
    let total = 0;
    let weight = 0;
    for (const [route, share] of Object.entries(routeMix)) {
      const value = table.routes[route]?.[0]?.[metric];
      if (value == null || share <= 0) continue;
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
      modelTtftMs: { prod: prod?.modelTtftMs ?? null, benchmarkP50Weighted: weighted('p50LatencyMs') },
    },
    cost: {
      prodPerRequestUsd: prod?.prodPerRequestUsd ?? { mean: null, p50: null },
      prodCacheReadShare: prod?.prodCacheReadShare ?? null,
      classifierPerRequestUsd: prod?.classifierPerRequestUsd ?? null,
      switchRate: prod?.switchRate ?? null,
      benchmarkPerTaskUsdWeighted: weighted('avgCostUsd'),
    },
    quality: {
      benchmarkAccuracyWeighted: weighted('accuracy'),
      classifierRouteAccuracy,
      heldOut: null,
    },
    routeMix,
  };
}
