import {
  CustomRoutingTableSchema,
  benchmarkPairKey,
  RANKING_POLICY_VERSION,
  rankCandidates,
  RoutingTableSchema,
  TAXONOMY_ROUTE_KEYS,
  type BenchmarkDeciderModel,
  type CandidatePricing,
  type ProductionTokenProfile,
  type BenchmarkModelSummary,
  type CustomRoutingTable,
  type BenchmarkPair,
  type RoutingTable,
  type TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import type { BenchmarkModelSummaryWithRun } from './db';

// Builds the full platform routing table from per-(model, taxonomy-route)
// decider summaries. Models with zero graded cases in a route are excluded from
// that route, as are models with no cost signal at all (avgCostUsd null means
// every case failed to report cost; ranking such a model as cheapest would hand
// it the route). Throws when any route ends up empty so the caller keeps the
// previous published table.
export function buildRoutingTable(params: {
  /** Table identity. Derived from the contributing registry rows, not one run. */
  version: string;
  generatedAt: string;
  minAccuracy: number;
  switchCostFactor: number;
  bestAccuracySwitchThreshold: number;
  productionTokenProfile?: ProductionTokenProfile | null;
  switchHorizonTurns?: number | null;
  lowConfidenceThreshold?: number | null;
  prices?: ReadonlyMap<string, CandidatePricing | null>;
  deciderModels: BenchmarkDeciderModel[];
  summaries: BenchmarkModelSummary[];
}): RoutingTable {
  const {
    version,
    generatedAt,
    minAccuracy,
    switchCostFactor,
    bestAccuracySwitchThreshold,
    deciderModels,
    summaries,
  } = params;
  // Bind every summary to its exact measured pair; never transfer alias scores.
  const snapshotVariant = (m: BenchmarkDeciderModel): string | null =>
    m.variant !== undefined ? (m.variant ?? null) : (m.reasoningEffort ?? null);

  const findSnapshot = (
    model: string,
    variant: string | null | undefined
  ): BenchmarkDeciderModel => {
    const appVariant = variant ?? null;
    const exact = deciderModels.find(m => m.id === model && snapshotVariant(m) === appVariant);
    if (exact) return exact;
    throw new Error(`no snapshot row for model ${model} variant ${JSON.stringify(appVariant)}`);
  };

  const routeCandidates = (routeKey: TaxonomyRouteKey) =>
    rankCandidates(
      summaries
        .filter(s => s.routeKey === routeKey && s.cases > 0 && s.avgCostUsd !== null)
        .map(s => {
          const cfg = findSnapshot(s.model, s.variant);
          const variant = snapshotVariant(cfg);
          return {
            model: s.model,
            accuracy: s.accuracy,
            cases: s.cases,
            avgCostUsd: s.avgCostUsd ?? 0,
            p50LatencyMs: s.p50LatencyMs,
            variant,
            pricing: params.prices?.get(s.model) ?? null,
          };
        }),
      minAccuracy,
      { profile: params.productionTokenProfile ?? null }
    );

  const routes = Object.fromEntries(
    TAXONOMY_ROUTE_KEYS.map(routeKey => [routeKey, routeCandidates(routeKey)] as const)
  );

  const table: RoutingTable = {
    version,
    generatedAt,
    minAccuracy,
    switchCostFactor,
    bestAccuracySwitchThreshold,
    productionTokenProfile: params.productionTokenProfile ?? null,
    switchHorizonTurns: params.switchHorizonTurns ?? null,
    lowConfidenceThreshold: params.lowConfidenceThreshold ?? null,
    source: 'benchmark',
    routes,
  };

  // RoutingTableSchema enforces .min(1) on each route array; throws ZodError
  // when a route is empty — caller logs and skips publish, keeping the previous
  // live table intact.
  return RoutingTableSchema.parse(table);
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Deterministic version id for a table assembled from the registry: a hash of
 * the contributing (runId, model, variant) triples and the ranking policy, so
 * identical assembly inputs produce the same id and cache-hit. Used by both the
 * platform table and each owner's sparse custom table.
 */
export function computeRegistryRoutingTableVersion(
  contributors: readonly { runId: string; model: string; variant: string | null }[],
  // The knobs are part of the table's identity, not just its metadata:
  // `rankCandidates` drops candidates below `minAccuracy`, and the other two
  // steer the router at serve time. Leaving them out lets a threshold-only
  // config save rebuild an identically versioned table, which the publisher
  // then skips — the live table would keep the old thresholds until some new
  // measurement happened to change the ready set.
  knobs: {
    minAccuracy: number;
    switchCostFactor: number;
    bestAccuracySwitchThreshold: number;
    productionTokenProfile?: ProductionTokenProfile | null;
    switchHorizonTurns?: number | null;
    lowConfidenceThreshold?: number | null;
    prices?: ReadonlyMap<string, CandidatePricing | null>;
  }
): string {
  const parts = [...contributors].map(c => `${c.runId}\0${c.model}\0${c.variant ?? ''}`).sort();
  // Read the knobs positionally: hashing the object would make the version
  // depend on the caller's key order.
  return `registry-${fnv1aHex(
    JSON.stringify({
      parts,
      knobs: [knobs.minAccuracy, knobs.switchCostFactor, knobs.bestAccuracySwitchThreshold],
      profile: knobs.productionTokenProfile
        ? [
            knobs.productionTokenProfile.uncachedInputTokens,
            knobs.productionTokenProfile.cachedInputTokens,
          ]
        : null,
      horizon: knobs.switchHorizonTurns ?? null,
      lowConfidenceThreshold: knobs.lowConfidenceThreshold ?? null,
      prices: [...new Set(contributors.map(c => c.model))].sort().map(model => {
        const pricing = knobs.prices?.get(model);
        return [
          model,
          pricing
            ? [
                pricing.promptUsdPerToken,
                pricing.completionUsdPerToken,
                pricing.cacheReadUsdPerToken,
              ]
            : null,
        ];
      }),
      // A ranking change reorders tables built from unchanged measurements.
      policy: RANKING_POLICY_VERSION,
    })
  )}`;
}

/**
 * Keep only summaries that belong to a ready entry's own measuring run: exact
 * (model, variant) AND run_id must match, so measurements never leak across
 * runs. Shared by the platform table and every owner's sparse custom table —
 * both read the same registry.
 */
export function filterSummariesByProvenance(
  readyEntries: readonly { entry: BenchmarkPair; runId: string }[],
  summaries: readonly BenchmarkModelSummaryWithRun[]
): BenchmarkModelSummaryWithRun[] {
  const provenanceByPair = new Map(
    readyEntries.map(r => [benchmarkPairKey(r.entry), r.runId] as const)
  );
  return summaries.filter(summary => {
    const pairKey = benchmarkPairKey({ model: summary.model, variant: summary.variant ?? null });
    return provenanceByPair.get(pairKey) === summary.runId;
  });
}

/**
 * Assemble a SPARSE custom routing table for the requested ready/current Pool
 * entries only. Uses per-route summaries from each profile's provenance run
 * only — exact (model, variant) AND run_id must match; no cross-run leakage.
 * Omits route keys with no graded candidates; returns null when no requested
 * entry contributes. Candidates carry exact `variant` (never reasoningEffort).
 */
export function buildCustomRoutingTable(params: {
  generatedAt: string;
  minAccuracy: number;
  switchCostFactor: number;
  bestAccuracySwitchThreshold: number;
  productionTokenProfile?: ProductionTokenProfile | null;
  switchHorizonTurns?: number | null;
  lowConfidenceThreshold?: number | null;
  prices?: ReadonlyMap<string, CandidatePricing | null>;
  /** Ready current profiles with provenance run ids. */
  readyEntries: readonly {
    entry: BenchmarkPair;
    runId: string;
  }[];
  /**
   * Summaries from provenance runs, each carrying its measuring `runId`.
   * Assembly selects only rows whose pair AND runId match the ready entry.
   */
  summaries: readonly BenchmarkModelSummaryWithRun[];
}): CustomRoutingTable | null {
  const {
    generatedAt,
    minAccuracy,
    switchCostFactor,
    bestAccuracySwitchThreshold,
    readyEntries,
    summaries,
  } = params;

  if (readyEntries.length === 0) return null;

  const filtered = filterSummariesByProvenance(readyEntries, summaries);

  const routes: CustomRoutingTable['routes'] = {};
  for (const routeKey of TAXONOMY_ROUTE_KEYS) {
    const candidates = rankCandidates(
      filtered
        .filter(s => s.routeKey === routeKey && s.cases > 0 && s.avgCostUsd !== null)
        .map(s => ({
          model: s.model,
          accuracy: s.accuracy,
          cases: s.cases,
          avgCostUsd: s.avgCostUsd ?? 0,
          p50LatencyMs: s.p50LatencyMs,
          pricing: params.prices?.get(s.model) ?? null,
          // Exact-pair identity only — never emit reasoningEffort on custom tables.
          variant: s.variant ?? null,
        })),
      minAccuracy,
      { profile: params.productionTokenProfile ?? null }
    );
    if (candidates.length > 0) {
      routes[routeKey] = candidates;
    }
  }

  if (Object.keys(routes).length === 0) return null;

  const version = computeRegistryRoutingTableVersion(
    readyEntries.map(r => ({
      runId: r.runId,
      model: r.entry.model,
      variant: r.entry.variant,
    })),
    {
      minAccuracy,
      switchCostFactor,
      bestAccuracySwitchThreshold,
      productionTokenProfile: params.productionTokenProfile,
      switchHorizonTurns: params.switchHorizonTurns,
      lowConfidenceThreshold: params.lowConfidenceThreshold,
      prices: params.prices,
    }
  );

  const table: CustomRoutingTable = {
    version,
    generatedAt,
    minAccuracy,
    switchCostFactor,
    bestAccuracySwitchThreshold,
    productionTokenProfile: params.productionTokenProfile ?? null,
    switchHorizonTurns: params.switchHorizonTurns ?? null,
    lowConfidenceThreshold: params.lowConfidenceThreshold ?? null,
    source: 'benchmark',
    routes,
  };

  return CustomRoutingTableSchema.parse(table);
}
