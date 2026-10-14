import {
  estimateRequestCostUsd,
  poolEntryKey,
  rankCandidates,
  type CandidatePricing,
  type ProductionTokenProfile,
} from '@kilocode/auto-routing-contracts';
import type {
  OfflineSweep,
  OfflineSweepSummary,
  ProdMetrics,
  ReplayMetrics,
  Scoreboard,
  ScoreboardRoutingTable,
} from './schema';

type BuildScoreboardInput = {
  label: string;
  table: ScoreboardRoutingTable;
  classifierRouteAccuracy: number | null;
  prod: ProdMetrics | null;
  replay: ReplayMetrics | null;
  now: Date;
  rerankProfile?: ProductionTokenProfile | null;
  costProfile?: ProductionTokenProfile | null;
  sweep?: OfflineSweep | null;
  rebuildFromSweep?: boolean;
  pricing?: Record<string, CandidatePricing | null> | null;
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
  sweep = null,
  rebuildFromSweep = false,
  pricing = null,
}: BuildScoreboardInput): Scoreboard {
  const profile = costProfile ?? rerankProfile ?? table.productionTokenProfile ?? null;
  if (rebuildFromSweep && !sweep) throw new Error('Rebuilding requires an offline sweep');
  const candidateKey = (candidate: {
    model: string;
    variant?: string | null;
    reasoningEffort?: string | null;
  }) =>
    poolEntryKey({
      model: candidate.model,
      variant: candidate.variant ?? candidate.reasoningEffort ?? null,
    });
  const storedPricing = new Map(
    Object.values(table.routes).flatMap(candidates =>
      candidates.map(candidate => [candidate.model, candidate.pricing ?? null] as const)
    )
  );
  const trainingRoutes: Record<string, OfflineSweepSummary[]> = {};
  if (rebuildFromSweep && sweep) {
    for (const summary of sweep.summaries) {
      if (summary.split !== 'train') continue;
      (trainingRoutes[summary.routeKey] ??= []).push(summary);
    }
  }
  const routes = rebuildFromSweep
    ? Object.fromEntries(
        Object.entries(trainingRoutes).flatMap(([route, summaries]) => {
          const measured = summaries.filter(
            (summary): summary is OfflineSweepSummary & { accuracy: number; avgCostUsd: number } =>
              summary.cases > 0 && summary.accuracy !== null && summary.avgCostUsd !== null
          );
          if (measured.length === 0) return [];
          const latencies = new Map(
            measured.map(summary => [candidateKey(summary), summary.p50LatencyMs])
          );
          const candidates = measured.map(
            ({ model, variant, accuracy, cases, avgCostUsd, p50LatencyMs }) => ({
              model,
              variant,
              accuracy,
              cases,
              avgCostUsd,
              p50LatencyMs,
              pricing: pricing ? (pricing[model] ?? null) : (storedPricing.get(model) ?? null),
            })
          );
          return [
            [
              route,
              rankCandidates(candidates, table.minAccuracy, { profile }).map(candidate => ({
                ...candidate,
                p50LatencyMs: latencies.get(candidateKey(candidate)) ?? null,
              })),
            ],
          ];
        })
      )
    : rerankProfile
      ? Object.fromEntries(
          Object.entries(table.routes).map(([route, candidates]) => {
            const latencies = Object.fromEntries(
              candidates.map(candidate => [candidateKey(candidate), candidate.p50LatencyMs])
            );
            const ranked = rankCandidates(
              candidates.map(candidate => ({
                ...candidate,
                p50LatencyMs: candidate.p50LatencyMs ?? null,
              })),
              table.minAccuracy,
              { profile: rerankProfile }
            ).map(candidate => ({
              ...candidate,
              p50LatencyMs: latencies[candidateKey(candidate)],
            }));
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

  const heldOutByRoute = new Map<string, Map<string, OfflineSweepSummary>>();
  for (const summary of sweep?.summaries ?? []) {
    if (summary.split !== 'heldOut') continue;
    let summaries = heldOutByRoute.get(summary.routeKey);
    if (!summaries) {
      summaries = new Map();
      heldOutByRoute.set(summary.routeKey, summaries);
    }
    summaries.set(candidateKey(summary), summary);
  }
  const heldOutPicks = Object.entries(routeMix).flatMap(([route, share]) => {
    const pick = routes[route]?.[0];
    const summary = pick && heldOutByRoute.get(route)?.get(candidateKey(pick));
    return summary && summary.cases > 0 && summary.accuracy !== null && pick && share > 0
      ? [{ pick, summary, share }]
      : [];
  });
  const heldOutWeighted = (metric: 'accuracy' | 'avgCostUsd' | 'p50LatencyMs'): number | null => {
    let total = 0;
    let weight = 0;
    for (const { pick, summary, share } of heldOutPicks) {
      let value: number | null;
      if (metric === 'avgCostUsd') {
        if (summary.avgCostUsd === null) continue;
        value = estimateRequestCostUsd(
          { avgCostUsd: summary.avgCostUsd, pricing: pick.pricing },
          profile
        );
      } else {
        value = summary[metric];
      }
      if (value === null) continue;
      total += value * share;
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
      heldOut: sweep
        ? {
            accuracyWeighted: heldOutWeighted('accuracy'),
            estimatedRequestUsdWeighted: heldOutWeighted('avgCostUsd'),
            p50LatencyMsWeighted: heldOutWeighted('p50LatencyMs'),
            routes: heldOutPicks.length,
          }
        : null,
    },
    routeMix,
  };
}
