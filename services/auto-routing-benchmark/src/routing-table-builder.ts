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
// published table. The routing knobs come from the run's snapshot, not live
// config.
export function buildRoutingTable(params: {
  runId: string;
  generatedAt: string;
  minAccuracy: number;
  switchCostFactor: number;
  bestAccuracySwitchThreshold: number;
  deciderModels: BenchmarkDeciderModel[];
  summaries: BenchmarkModelSummary[];
}): RoutingTable {
  const {
    runId,
    generatedAt,
    minAccuracy,
    switchCostFactor,
    bestAccuracySwitchThreshold,
    deciderModels,
    summaries,
  } = params;
  // Prefer exact (model, variant) match so two variants of one model keep
  // distinct snapshot rows. Legacy / platform: when the snapshot has exactly
  // one row for the model (one effort per model), bind that row even if the
  // summary omitted variant. Multiple snapshot rows without an exact match is
  // corrupt — throw so buildRoutingTable fails and the caller keeps the
  // previous published table. Emit reasoningEffort only — never variant — so
  // the published PLATFORM artifact shape stays unchanged for rolling deploys.
  const snapshotVariant = (m: BenchmarkDeciderModel): string | null =>
    m.variant !== undefined ? (m.variant ?? null) : (m.reasoningEffort ?? null);

  const findSnapshot = (
    model: string,
    variant: string | null | undefined
  ): BenchmarkDeciderModel => {
    const appVariant = variant ?? null;
    const exact = deciderModels.find(m => m.id === model && snapshotVariant(m) === appVariant);
    if (exact) return exact;
    const forModel = deciderModels.filter(m => m.id === model);
    const sole = forModel.length === 1 ? forModel[0] : undefined;
    // Exactly one snapshot row for this model → platform/legacy shape.
    if (sole) return sole;
    throw new Error(
      `no snapshot row for model ${model} variant ${JSON.stringify(appVariant)} (${forModel.length} rows for model)`
    );
  };

  const routeCandidates = (routeKey: TaxonomyRouteKey) =>
    rankCandidates(
      summaries
        .filter(s => s.routeKey === routeKey && s.cases > 0 && s.avgCostUsd !== null)
        .map(s => {
          const cfg = findSnapshot(s.model, s.variant);
          // Platform artifact: emit reasoningEffort from the run snapshot's
          // effort key, NOT variant (custom sparse tables are a later slice).
          const effort =
            cfg?.reasoningEffort !== undefined && cfg.reasoningEffort !== null
              ? cfg.reasoningEffort
              : null;
          return {
            model: s.model,
            accuracy: s.accuracy,
            avgCostUsd: s.avgCostUsd ?? 0,
            reasoningEffort: effort,
          };
        }),
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
    bestAccuracySwitchThreshold,
    source: 'benchmark',
    routes,
  };

  // RoutingTableSchema enforces .min(1) on each route array; throws ZodError
  // when a route is empty — caller logs and skips publish, keeping the previous
  // live table intact.
  return RoutingTableSchema.parse(table);
}
