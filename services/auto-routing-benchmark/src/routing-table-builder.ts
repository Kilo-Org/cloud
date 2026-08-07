import {
  CustomRoutingTableSchema,
  poolEntryKey,
  rankCandidates,
  RoutingTableSchema,
  TAXONOMY_ROUTE_KEYS,
  type BenchmarkDeciderModel,
  type BenchmarkModelSummary,
  type CustomRoutingTable,
  type PoolEntry,
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
  // Prefer exact (model, variant) match so two variants of one model keep
  // distinct snapshot rows. Legacy / platform: when the snapshot has exactly
  // one row for the model (one effort per model), bind that row even if the
  // summary omitted variant. Multiple snapshot rows without an exact match is
  // corrupt — throw so buildRoutingTable fails and the caller keeps the
  // previous published table.
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
          const effort = cfg.reasoningEffort ?? null;
          // Legacy enum efforts keep the exact current shape. A snapshot that only
          // has a non-enum variant emits `variant` instead — never both.
          const variant = effort === null ? (cfg.variant ?? null) : null;
          return {
            model: s.model,
            accuracy: s.accuracy,
            avgCostUsd: s.avgCostUsd ?? 0,
            ...(variant !== null ? { variant } : {}),
            reasoningEffort: effort,
          };
        }),
      minAccuracy
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
 * the contributing (runId, model, variant) triples, so identical assembly
 * inputs produce the same id and cache-hit. Used by both the platform table and
 * each owner's sparse custom table.
 */
export function computeRegistryRoutingTableVersion(
  contributors: readonly { runId: string; model: string; variant: string | null }[]
): string {
  const parts = [...contributors].map(c => `${c.runId}\0${c.model}\0${c.variant ?? ''}`).sort();
  return `registry-${fnv1aHex(JSON.stringify(parts))}`;
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
  switchCostFactor: number;
  bestAccuracySwitchThreshold: number;
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
          avgCostUsd: s.avgCostUsd ?? 0,
          // Exact-pair identity only — never emit reasoningEffort on custom tables.
          variant: s.variant ?? null,
        })),
      minAccuracy
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
    }))
  );

  const table: CustomRoutingTable = {
    version,
    generatedAt,
    minAccuracy,
    switchCostFactor,
    bestAccuracySwitchThreshold,
    source: 'benchmark',
    routes,
  };

  return CustomRoutingTableSchema.parse(table);
}
