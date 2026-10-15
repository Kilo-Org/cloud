import {
  CustomRoutingTableSchema,
  poolEntryKey,
  RANKING_POLICY_VERSION,
  rankCandidates,
  RoutingTableSchema,
  TAXONOMY_ROUTE_KEYS,
  ReasoningComplexitySchema,
  type ComplexityLabels,
  type EffortByComplexity,
  type BenchmarkDeciderModel,
  type AutoRouter,
  type CandidatePricing,
  type ProductionTokenProfile,
  type BenchmarkModelSummary,
  type CustomRoutingTable,
  type PoolEntry,
  type RoutingTable,
  type TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import type { BenchmarkModelSummaryWithRun } from './db';
import type { OfflineSweep } from './scoreboard/schema';
import { isGradedSweepResult, summarizeSweep } from './scoreboard/sweep';

export const MIN_COMPLEXITY_CASES = 6;

export function buildEffortByComplexity(
  routes: RoutingTable['routes'],
  perCaseResults: OfflineSweep['pairs'],
  labels: ComplexityLabels,
  minAccuracy: number,
  profile: ProductionTokenProfile | null = null,
  accuracyNoiseBand?: number
): EffortByComplexity {
  const mapping: EffortByComplexity = {};
  for (const bucket of ReasoningComplexitySchema.options) {
    const pairs = perCaseResults.map(pair => ({
      ...pair,
      results: pair.results.filter(
        result => result.split === 'train' && labels[result.caseId] === bucket
      ),
    }));
    const summaries = summarizeSweep(pairs);
    const caseIdsByPairRoute = new Map<string, Set<string>>();
    for (const pair of pairs) {
      for (const result of pair.results) {
        if (!isGradedSweepResult(result)) continue;
        const key = JSON.stringify([pair.model, pair.variant, result.routeKey]);
        let caseIds = caseIdsByPairRoute.get(key);
        if (!caseIds) {
          caseIds = new Set();
          caseIdsByPairRoute.set(key, caseIds);
        }
        caseIds.add(result.caseId);
      }
    }
    for (const [route, candidates] of Object.entries(routes)) {
      const routeMapping = (mapping[route] ??= {});
      for (const candidate of candidates) {
        if (routeMapping[candidate.model]?.[bucket] !== undefined) continue;
        const modelCandidates = candidates.filter(c => c.model === candidate.model);
        const measured = summaries.filter(
          (summary): summary is typeof summary & { accuracy: number; avgCostUsd: number } =>
            summary.routeKey === route &&
            summary.model === candidate.model &&
            summary.accuracy !== null &&
            summary.avgCostUsd !== null &&
            summary.cases >= MIN_COMPLEXITY_CASES &&
            (caseIdsByPairRoute.get(JSON.stringify([summary.model, summary.variant, route]))
              ?.size ?? 0) >= MIN_COMPLEXITY_CASES &&
            modelCandidates.some(c => (c.variant ?? c.reasoningEffort ?? null) === summary.variant)
        );
        const ranked = rankCandidates(
          measured.map(summary => ({ ...summary, pricing: candidate.pricing })),
          minAccuracy,
          { profile, accuracyNoiseBand }
        );
        (routeMapping[candidate.model] ??= {})[bucket] = ranked[0]
          ? (ranked[0].variant ?? null)
          : (candidate.variant ?? candidate.reasoningEffort ?? null);
      }
    }
  }
  return mapping;
}

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
  accuracyNoiseBand?: number;
  switchCostFactor: number;
  bestAccuracySwitchThreshold: number;
  productionTokenProfile?: ProductionTokenProfile | null;
  switchHorizonTurns?: number | null;
  lowConfidenceThreshold?: number | null;
  prices?: ReadonlyMap<string, CandidatePricing | null>;
  deciderModels: BenchmarkDeciderModel[];
  summaries: BenchmarkModelSummary[];
  perCaseResults?: OfflineSweep['pairs'];
  complexityLabels?: ComplexityLabels;
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
            p50TtftMs: s.p50TtftMs,
            variant,
            pricing: params.prices?.get(s.model) ?? null,
          };
        }),
      minAccuracy,
      {
        profile: params.productionTokenProfile ?? null,
        accuracyNoiseBand: params.accuracyNoiseBand,
      }
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
    ...(params.perCaseResults && params.complexityLabels
      ? {
          effortByComplexity: buildEffortByComplexity(
            routes,
            params.perCaseResults,
            params.complexityLabels,
            minAccuracy,
            params.productionTokenProfile ?? null,
            params.accuracyNoiseBand
          ),
        }
      : {}),
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
    router?: AutoRouter;
    engineIdentity?: string;
    accuracyNoiseBand?: number;
    frontierMinAccuracyDelta?: number;
    minAccuracy: number;
    switchCostFactor: number;
    bestAccuracySwitchThreshold: number;
    productionTokenProfile?: ProductionTokenProfile | null;
    switchHorizonTurns?: number | null;
    lowConfidenceThreshold?: number | null;
    prices?: ReadonlyMap<string, CandidatePricing | null>;
    summaries?: readonly BenchmarkModelSummary[];
    effortByComplexity?: EffortByComplexity;
  }
): string {
  const parts = [...contributors].map(c => `${c.runId}\0${c.model}\0${c.variant ?? ''}`).sort();
  // Read the knobs positionally: hashing the object would make the version
  // depend on the caller's key order.
  return `${knobs.router === 'frontier' ? 'frontier-' : ''}registry-${fnv1aHex(
    JSON.stringify({
      parts,
      router: knobs.router ?? 'efficient',
      engineIdentity: knobs.engineIdentity ?? null,
      accuracyNoiseBand: knobs.accuracyNoiseBand ?? 0.05,
      frontierMinAccuracyDelta: knobs.frontierMinAccuracyDelta ?? 0,
      knobs: [knobs.minAccuracy, knobs.switchCostFactor, knobs.bestAccuracySwitchThreshold],
      profile: knobs.productionTokenProfile
        ? [
            knobs.productionTokenProfile.uncachedInputTokens,
            knobs.productionTokenProfile.cachedInputTokens,
          ]
        : null,
      horizon: knobs.switchHorizonTurns ?? null,
      lowConfidenceThreshold: knobs.lowConfidenceThreshold ?? null,
      effortByComplexity: Object.entries(knobs.effortByComplexity ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([route, models]) => [
          route,
          Object.entries(models)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([model, buckets]) => [
              model,
              ReasoningComplexitySchema.options.map(bucket => ({
                bucket,
                variant: buckets[bucket],
              })),
            ]),
        ]),
      ttfts: (knobs.summaries ?? [])
        .map(summary => [
          summary.model,
          summary.variant ?? null,
          summary.routeKey,
          summary.p50TtftMs ?? null,
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
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
  readyEntries: readonly { entry: PoolEntry; runId: string }[],
  summaries: readonly BenchmarkModelSummaryWithRun[]
): BenchmarkModelSummaryWithRun[] {
  const provenanceByPair = new Map(
    readyEntries.map(r => [poolEntryKey(r.entry), r.runId] as const)
  );
  return summaries.filter(summary => {
    const pairKey = poolEntryKey({ model: summary.model, variant: summary.variant ?? null });
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
  accuracyNoiseBand?: number;
  switchCostFactor: number;
  bestAccuracySwitchThreshold: number;
  productionTokenProfile?: ProductionTokenProfile | null;
  switchHorizonTurns?: number | null;
  lowConfidenceThreshold?: number | null;
  prices?: ReadonlyMap<string, CandidatePricing | null>;
  perCaseResults?: OfflineSweep['pairs'];
  complexityLabels?: ComplexityLabels;
  /** Ready current profiles with provenance run ids. */
  readyEntries: readonly {
    entry: PoolEntry;
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
          p50TtftMs: s.p50TtftMs,
          pricing: params.prices?.get(s.model) ?? null,
          // Exact-pair identity only — never emit reasoningEffort on custom tables.
          variant: s.variant ?? null,
        })),
      minAccuracy,
      {
        profile: params.productionTokenProfile ?? null,
        accuracyNoiseBand: params.accuracyNoiseBand,
      }
    );
    if (candidates.length > 0) {
      routes[routeKey] = candidates;
    }
  }

  if (Object.keys(routes).length === 0) return null;
  const effortByComplexity =
    params.perCaseResults && params.complexityLabels
      ? buildEffortByComplexity(
          routes,
          params.perCaseResults,
          params.complexityLabels,
          minAccuracy,
          params.productionTokenProfile ?? null,
          params.accuracyNoiseBand
        )
      : undefined;

  const version = computeRegistryRoutingTableVersion(
    readyEntries.map(r => ({
      runId: r.runId,
      model: r.entry.model,
      variant: r.entry.variant,
    })),
    {
      minAccuracy,
      accuracyNoiseBand: params.accuracyNoiseBand,
      switchCostFactor,
      bestAccuracySwitchThreshold,
      productionTokenProfile: params.productionTokenProfile,
      switchHorizonTurns: params.switchHorizonTurns,
      lowConfidenceThreshold: params.lowConfidenceThreshold,
      prices: params.prices,
      summaries: filtered,
      effortByComplexity,
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
    ...(effortByComplexity ? { effortByComplexity } : {}),
  };

  return CustomRoutingTableSchema.parse(table);
}
