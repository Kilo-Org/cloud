import {
  rankCandidates,
  RoutingTableSchema,
  TAXONOMY_ROUTE_KEYS,
  type BenchmarkDeciderModel,
  type BenchmarkModelSummary,
  type RoutingTable,
  type TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';

// Builds the routing table from per-(model, taxonomy-route) decider summaries. Models
// with zero graded cases in a route are excluded from that route, as are
// models with no cost signal at all (avgCostUsd null means every case failed
// to report cost; ranking such a model as cheapest would hand it the route).
// Throws when any route ends up empty so the caller keeps the previous
// published table. deciderModels/minAccuracy/switchCostFactor come from the
// run's snapshot, not live config.
export function buildRoutingTable(params: {
  runId: string;
  generatedAt: string;
  minAccuracy: number;
  switchCostFactor: number;
  deciderModels: BenchmarkDeciderModel[];
  summaries: BenchmarkModelSummary[];
}): RoutingTable {
  const { runId, generatedAt, minAccuracy, switchCostFactor, deciderModels, summaries } = params;
  const modelConfigById = new Map(deciderModels.map(m => [m.id, m] as const));

  const routeCandidates = (routeKey: TaxonomyRouteKey) =>
    rankCandidates(
      summaries
        .filter(s => s.routeKey === routeKey && s.cases > 0 && s.avgCostUsd !== null)
        .map(s => ({
          model: s.model,
          accuracy: s.accuracy,
          avgCostUsd: s.avgCostUsd ?? 0,
          reasoningEffort: modelConfigById.get(s.model)?.reasoningEffort ?? null,
        })),
      minAccuracy
    );

  const routes = Object.fromEntries(
    TAXONOMY_ROUTE_KEYS.map(routeKey => [routeKey, routeCandidates(routeKey)] as const)
  );

  const table: RoutingTable = {
    version: runId,
    generatedAt,
    minAccuracy,
    switchCostFactor,
    source: 'benchmark',
    routes,
  };

  // RoutingTableSchema enforces .min(1) on each route array; throws ZodError
  // when a route is empty — caller logs and skips publish, keeping the previous
  // live table intact.
  return RoutingTableSchema.parse(table);
}
