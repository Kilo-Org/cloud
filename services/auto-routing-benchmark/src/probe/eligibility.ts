import {
  benchmarkPairKey,
  taxonomyRouteKey,
  type AutoRouter,
  type BenchmarkModelSummary,
  type BenchmarkPair,
  type RoutingTable,
  type TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import * as z from 'zod';
import { countProbeCaseResults } from '../db';
import { PROBE_CASES } from '../datasets/probe-cases';
import { variantToStorage } from '../reasoning-effort';
import { probeEligibilityKvKey, routingTableVersionKvKey } from '../routing-table-cache-keys';
import type { OfflineSweep } from '../scoreboard/schema';

/** The agentic routes a probe measures: the subtasks of the probe transcripts. */
export const PROBE_ROUTE_KEYS: readonly TaxonomyRouteKey[] = [
  ...new Set(PROBE_CASES.map(probeCase => taxonomyRouteKey(probeCase))),
];

/**
 * The pairs whose provenance run lacks a probe result at the probe revision.
 *
 * This answer is stable between two publications — it moves only when a run completes, a
 * publish rewrites provenance, or a pair is added — so a hot reader must not pay for the
 * scan twice. Given an `env`, the answer is cached in KV under `probeEligibilityKvKey` and
 * stamped with the router's current publication pointer: a bare KV read replaces the scan,
 * and a publish both deletes the entry and moves the pointer, so an entry written by a
 * reader that raced a publish is never served.
 *
 * Without an `env` (tests, callers with no KV) it scans, which is always correct.
 */
export type ProbeEligibilityEnv = { AUTO_ROUTING_CONFIG: KVNamespace };

export async function pairsMissingProbeResults(
  db: D1Database,
  params: {
    entries: readonly { entry: BenchmarkPair; runId: string }[];
    revision: number;
    router?: AutoRouter;
    env?: ProbeEligibilityEnv;
    /**
     * True only for a caller that passes every ready pair of the router. A reader that asks
     * about a subset (one owner's custom-router pool) may consume the shared answer but must
     * never store its own: a smaller set would tell the next reader that a pair it never
     * looked at is eligible. Consuming a superset is always correct — callers only ask
     * membership of their own pairs.
     */
    cacheFullSet?: boolean;
  }
): Promise<Set<string>> {
  const router = params.router;
  const kv = params.env?.AUTO_ROUTING_CONFIG;
  const cache = kv && router ? { kv, key: probeEligibilityKvKey(router) } : null;
  const token = cache && router ? await readPublicationPointer(cache.kv, router) : null;
  if (cache && token !== null) {
    const cached = await readEligibilityCache(cache, token);
    if (cached !== null) return new Set(cached);
  }
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
  if (cache && token !== null && params.cacheFullSet) {
    await writeEligibilityCache(cache, token, missing);
  }
  return missing;
}

const CACHE_ERROR = 'probe_eligibility_cache_failed';

/** The publication a cached answer must still match: its version plus `publishedAt`. */
async function readPublicationPointer(kv: KVNamespace, router: AutoRouter): Promise<string | null> {
  try {
    return (await kv.get(routingTableVersionKvKey(router))) ?? 'unpublished';
  } catch (error) {
    console.warn(JSON.stringify({ event: CACHE_ERROR, site: 'pointer', router, ...formatError(error) }));
    return null;
  }
}

type EligibilityCache = { kv: KVNamespace; key: string };

async function readEligibilityCache(
  cache: EligibilityCache,
  token: string
): Promise<string[] | null> {
  try {
    const raw = await cache.kv.get(cache.key);
    if (raw === null) return null;
    const parsed = z
      .object({ token: z.string(), ineligible: z.array(z.string()) })
      .safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.token !== token) return null;
    return parsed.data.ineligible;
  } catch (error) {
    console.warn(
      JSON.stringify({ event: CACHE_ERROR, site: 'read', key: cache.key, ...formatError(error) })
    );
    return null;
  }
}

async function writeEligibilityCache(
  cache: EligibilityCache,
  token: string,
  ineligible: ReadonlySet<string>
): Promise<void> {
  try {
    await cache.kv.put(cache.key, JSON.stringify({ token, ineligible: [...ineligible] }));
  } catch (error) {
    console.warn(
      JSON.stringify({ event: CACHE_ERROR, site: 'write', key: cache.key, ...formatError(error) })
    );
  }
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
