import {
  benchmarkPairKey,
  taxonomyRouteKey,
  type BenchmarkModelSummary,
  type BenchmarkPair,
  type RoutingTable,
  type TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import { countProbeCaseResults } from '../db';
import { PROBE_CASES } from '../datasets/probe-cases';
import { variantToStorage } from '../reasoning-effort';
import type { OfflineSweep } from '../scoreboard/schema';

/** The agentic routes a probe measures: the subtasks of the probe transcripts. */
export const PROBE_ROUTE_KEYS: readonly TaxonomyRouteKey[] = [
  ...new Set(PROBE_CASES.map(probeCase => taxonomyRouteKey(probeCase))),
];

/** The pairs whose provenance run lacks a probe result at the probe revision. */
export async function pairsMissingProbeResults(
  db: D1Database,
  params: { entries: readonly { entry: BenchmarkPair; runId: string }[]; revision: number }
): Promise<Set<string>> {
  const complete = new Set<string>();
  const rows = await countProbeCaseResults(db, {
    pairs: params.entries.map(({ entry, runId }) => ({
      runId,
      model: entry.model,
      variant: variantToStorage(entry.variant),
    })),
    caseIds: PROBE_CASES.map(probeCase => probeCase.id),
    revision: params.revision,
  });
  for (const row of rows) {
    if (row.probes < PROBE_CASES.length) continue;
    complete.add(JSON.stringify([row.run_id, row.model, row.variant]));
  }
  const missing = new Set<string>();
  for (const { entry, runId } of params.entries) {
    if (!complete.has(JSON.stringify([runId, entry.model, variantToStorage(entry.variant)]))) {
      missing.add(benchmarkPairKey(entry));
    }
  }
  return missing;
}

/**
 * A pair without complete probe results is ineligible on the agentic routes only: its
 * results for those routes are dropped, every other route keeps its measurement.
 */
export function dropIneligibleAgenticResults(
  pairs: OfflineSweep['pairs'],
  ineligible: ReadonlySet<string>
): OfflineSweep['pairs'] {
  if (ineligible.size === 0) return pairs;
  const routes = new Set<string>(PROBE_ROUTE_KEYS);
  return pairs.flatMap(pair => {
    if (!ineligible.has(benchmarkPairKey({ model: pair.model, variant: pair.variant }))) {
      return [pair];
    }
    const results = pair.results.filter(result => !routes.has(result.routeKey));
    return results.length > 0 ? [{ ...pair, results }] : [];
  });
}

export function dropIneligibleAgenticSummaries<T extends BenchmarkModelSummary>(
  summaries: readonly T[],
  ineligible: ReadonlySet<string>
): T[] {
  if (ineligible.size === 0) return [...summaries];
  const routes = new Set<string>(PROBE_ROUTE_KEYS);
  return summaries.filter(
    summary =>
      !routes.has(summary.routeKey) ||
      !ineligible.has(benchmarkPairKey({ model: summary.model, variant: summary.variant ?? null }))
  );
}

export type AgenticEligibilityView<T extends BenchmarkModelSummary> = {
  summaries: T[];
  perCaseResults: OfflineSweep['pairs'];
  fallbackRoutes: Partial<Record<TaxonomyRouteKey, RoutingTable['routes'][TaxonomyRouteKey]>>;
  heldRouteKeys: TaxonomyRouteKey[];
};

/**
 * What the platform table may rank after activation: an ineligible pair keeps every
 * non-agentic route, and an agentic route with no eligible pair keeps the candidates the
 * live table already serves instead of emptying.
 */
export function agenticEligibilityView<T extends BenchmarkModelSummary>(params: {
  active: boolean;
  ineligible: ReadonlySet<string>;
  summaries: readonly T[];
  perCaseResults: OfflineSweep['pairs'];
  previousRoutes?: RoutingTable['routes'];
}): AgenticEligibilityView<T> {
  if (!params.active) {
    return {
      summaries: [...params.summaries],
      perCaseResults: params.perCaseResults,
      fallbackRoutes: {},
      heldRouteKeys: [],
    };
  }
  const summaries = dropIneligibleAgenticSummaries(params.summaries, params.ineligible);
  const perCaseResults = dropIneligibleAgenticResults(params.perCaseResults, params.ineligible);
  const heldRouteKeys = agenticRoutesWithoutCandidates(summaries);
  const fallbackRoutes = Object.fromEntries(
    heldRouteKeys.flatMap(routeKey => {
      const candidates = params.previousRoutes?.[routeKey];
      return candidates && candidates.length > 0 ? [[routeKey, candidates]] : [];
    })
  );
  return { summaries, perCaseResults, fallbackRoutes, heldRouteKeys };
}

/** Agentic routes the given summaries leave without a single candidate. */
export function agenticRoutesWithoutCandidates(
  summaries: readonly BenchmarkModelSummary[]
): TaxonomyRouteKey[] {
  const covered = new Set<string>(
    summaries.filter(s => s.cases > 0 && s.avgCostUsd !== null).map(s => s.routeKey)
  );
  return PROBE_ROUTE_KEYS.filter(routeKey => !covered.has(routeKey));
}
