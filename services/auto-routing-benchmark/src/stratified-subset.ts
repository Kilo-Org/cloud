import {
  rankCandidates,
  type CandidatePricing,
  type ProductionTokenProfile,
  type TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import { estimateRequestCostUsd } from '@kilocode/auto-routing-contracts';

/**
 * Expensive pairs first run a stratified subset of their cases (lever 4), and run the
 * remaining cases only when the subset says the pair is in contention. Everything that
 * decides this is pure so the offline agreement report replays the same code the worker
 * runs (`scripts/stratified-subset-agreement.ts`).
 */

/** Share of each route's cases one subset measures, before the per-stratum floor. */
export const SUBSET_FRACTION = 0.25;
/**
 * Cases a stratum keeps even when the fraction rounds it away. Long-context strata hold one
 * case per route, so the floor keeps every bucket measured; a stratum smaller than the floor
 * keeps all the cases it has.
 */
export const SUBSET_MIN_PER_STRATUM = 3;
/**
 * A pair counts as expensive when its estimated cost per case is this many times the median
 * of the candidates measured alongside it. 2x is the documented line: the router picks on
 * accuracy first, so a pair above it pays for the full suite to learn what the subset already
 * says, while a pair below it is cheap enough that cutting it saves nothing worth a second
 * admission round.
 */
export const EXPENSIVE_MULTIPLIER = 2;

export const SUBSET_BUCKETS = ['plain', 'long-1', 'long-2', 'long-3'] as const;
export type SubsetBucket = (typeof SUBSET_BUCKETS)[number];

/**
 * The context bucket a case measures: `plain`, or the long-context tier its id names
 * (`long-<tier>-...`, matching the datasets in src/datasets/long-context).
 */
export function caseBucket(caseId: string): SubsetBucket {
  if (!caseId.startsWith('long-')) return 'plain';
  const tier = caseId.slice('long-'.length, 'long-'.length + 1);
  return tier === '1' || tier === '2' || tier === '3' ? `long-${tier}` : 'plain';
}

/**
 * Stable rank of a case id: FNV-1a over the id, widened with a second multiply so ids that
 * differ in one character do not sit next to each other. The subset must not depend on the
 * dataset's order (a new case must not shift every existing pick), so the selection sorts by
 * this value instead of slicing the array.
 */
export function caseRank(caseId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < caseId.length; i++) {
    hash ^= caseId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 0x85ebca6b);
  }
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Cases one stratum keeps: the fraction, raised to the stratum floor, capped at what exists. */
export function stratumSize(total: number): number {
  if (total <= 0) return 0;
  return Math.min(total, Math.max(SUBSET_MIN_PER_STRATUM, Math.ceil(total * SUBSET_FRACTION)));
}

/**
 * The subset of one route's cases, deterministic for a given set of ids: every bucket is
 * kept, each keeps the top-ranked {@link stratumSize} of its cases.
 */
export function selectRouteSubset(caseIds: readonly string[]): string[] {
  const byBucket = new Map<SubsetBucket, string[]>();
  for (const caseId of caseIds) {
    const bucket = caseBucket(caseId);
    const bucketIds = byBucket.get(bucket);
    if (bucketIds) bucketIds.push(caseId);
    else byBucket.set(bucket, [caseId]);
  }
  const ranked = (ids: readonly string[]) =>
    [...ids].sort((a, b) => caseRank(a) - caseRank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const selected: string[] = [];
  for (const bucket of SUBSET_BUCKETS) {
    const bucketIds = byBucket.get(bucket);
    if (!bucketIds) continue;
    selected.push(...ranked(bucketIds).slice(0, stratumSize(bucketIds.length)));
  }
  // Dataset order, so the subset list reads like the suite it was cut from.
  const kept = new Set(selected);
  return caseIds.filter(caseId => kept.has(caseId));
}

/**
 * The subset of a whole suite: each taxonomy route is stratified on its own, because the
 * router ranks within a route and one route's long-context tail must not thin another's.
 */
export function selectSuiteSubset(
  cases: readonly { id: string; taskType: string; subtaskType: string }[]
): string[] {
  const byRoute = new Map<string, string[]>();
  for (const benchCase of cases) {
    const route = `${benchCase.taskType}/${benchCase.subtaskType}`;
    const routeIds = byRoute.get(route);
    if (routeIds) routeIds.push(benchCase.id);
    else byRoute.set(route, [benchCase.id]);
  }
  const kept = new Set<string>();
  for (const routeIds of byRoute.values()) {
    for (const caseId of selectRouteSubset(routeIds)) kept.add(caseId);
  }
  return cases.map(benchCase => benchCase.id).filter(caseId => kept.has(caseId));
}

/**
 * Estimated cost of one case at the catalog's token prices: the estimator the ranking uses,
 * with the observed shell cost at zero because an unmeasured pair has none. Without a
 * production token profile there is no token volume to price, so the blended per-token price
 * (3 input : 1 output, the same weighting contracts uses for summaries without tokens) is the
 * comparable unit instead. Null when the catalog has no price.
 */
export function estimateCaseCostUsd(
  pricing: CandidatePricing | null | undefined,
  profile: ProductionTokenProfile | null
): number | null {
  if (!pricing) return null;
  if (profile) return estimateRequestCostUsd({ avgCostUsd: 0, pricing }, profile);
  // No profile: the router has no request size to price either, so compare the tokens at
  // the same 3-input:1-output blend contracts uses for summaries without token counts.
  return (3 * pricing.promptUsdPerToken + pricing.completionUsdPerToken) / 4;
}

export type PairCaseCost = { key: string; perCaseUsd: number | null };

/**
 * Which of the pairs being measured are expensive: cost per case above
 * {@link EXPENSIVE_MULTIPLIER} times the median of the same pool. A pair whose price the
 * catalog does not publish is never expensive, because the subset decision must not rest on
 * an unknown.
 *
 * The pool is the run's own entries. The catalog price is per token, so the estimate carries
 * no route dimension today; the per-route comparison exists so a route-aware estimate can be
 * dropped in without changing the caller.
 */
export function expensivePairKeys(
  pairs: readonly PairCaseCost[],
  multiplier: number = EXPENSIVE_MULTIPLIER
): { expensive: Set<string>; medianUsd: number | null } {
  const known = pairs.flatMap(pair =>
    pair.perCaseUsd === null ? [] : [{ key: pair.key, perCaseUsd: pair.perCaseUsd }]
  );
  if (known.length < 2) return { expensive: new Set(), medianUsd: null };
  const sorted = known.map(pair => pair.perCaseUsd).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianUsd =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  if (!(medianUsd > 0)) return { expensive: new Set(), medianUsd };
  const threshold = medianUsd * multiplier;
  return {
    expensive: new Set(known.filter(pair => pair.perCaseUsd > threshold).map(pair => pair.key)),
    medianUsd,
  };
}

/** One-sided upper confidence bound of an accuracy from `n` graded cases (Wilson, z=1). */
export function wilsonUpperBound(accuracy: number, n: number, zScore = 1): number {
  if (n <= 0) return 1;
  const z2 = zScore * zScore;
  const denominator = 1 + z2 / n;
  const center = accuracy + z2 / (2 * n);
  const margin = zScore * Math.sqrt((accuracy * (1 - accuracy) + z2 / (4 * n)) / n);
  return Math.min(1, (center + margin) / denominator);
}

export type RouteMeasurement = {
  routeKey: TaxonomyRouteKey;
  /** Graded rows, repetitions included. */
  graded: number;
  /** Distinct graded cases: the independent sample a confidence bound may use. */
  gradedCases: number;
  accuracy: number;
  costUsd: number | null;
};

/** Per-route accuracy and per-case cost of a set of measured rows. Ungraded rows are skipped. */
export function summarizeMeasuredRows(
  rows: readonly {
    case_id: string;
    route_key: string | null;
    score: number;
    cost_usd: number | null;
    error: string | null;
    timed_out: number;
  }[]
): RouteMeasurement[] {
  const groups = new Map<
    string,
    { score: number; cost: number; costed: number; n: number; cases: Set<string> }
  >();
  for (const row of rows) {
    if (row.route_key === null || row.error !== null || row.timed_out !== 0) continue;
    const group = groups.get(row.route_key) ?? {
      score: 0,
      cost: 0,
      costed: 0,
      n: 0,
      cases: new Set<string>(),
    };
    group.score += row.score;
    group.n += 1;
    group.cases.add(row.case_id);
    if (row.cost_usd !== null) {
      group.cost += row.cost_usd;
      group.costed += 1;
    }
    groups.set(row.route_key, group);
  }
  return [...groups.entries()].map(([routeKey, group]) => ({
    routeKey: routeKey as TaxonomyRouteKey,
    graded: group.n,
    gradedCases: group.cases.size,
    accuracy: group.n > 0 ? group.score / group.n : 0,
    costUsd: group.costed > 0 ? group.cost / group.costed : null,
  }));
}

export type ContentionPeer = {
  model: string;
  accuracy: number;
  cases: number | null;
  avgCostUsd: number;
};

export type RouteContention = {
  routeKey: TaxonomyRouteKey;
  inContention: boolean;
  /** True when the route has no measured peer, so any measured pair would lead it. */
  openRoute: boolean;
  /** Rank of the subset's upper-bound hypothesis among the route's ranked candidates (0-based). */
  rank: number | null;
};

/**
 * Candidates per route that can serve. The published table is ranked, but a served request is
 * decided after org denials are removed, so the second-ranked candidate leads whenever the
 * first is denied for that org. A pair outside this window cannot serve on the route.
 */
export const SUBSET_CONTENTION_TOP_K = 2;

/**
 * Why a subset measurement is in contention on one route: it could rank inside the route's
 * served window on value, be the cheapest candidate that clears the floor, or be the most
 * accurate. Those are exactly what `computeDecision` can pick on a route (its mode overrides
 * choose the cheapest and the most accurate), so a pair that is none of them can never be
 * routed to and the rest of its cases buy nothing.
 */
export function routeContention(input: {
  routeKey: TaxonomyRouteKey;
  measured: RouteMeasurement;
  peers: readonly ContentionPeer[];
  minAccuracy: number;
  accuracyNoiseBand: number;
}): RouteContention {
  const { routeKey, measured, peers, minAccuracy } = input;
  // A subset's accuracy is a lower estimate of the pair's; the bound is the value the pair
  // could reach if every unmeasured case behaved best. Repetitions of one case are not
  // independent, so the bound counts distinct cases.
  const accuracyUpper = wilsonUpperBound(measured.accuracy, measured.gradedCases);
  if (peers.length === 0) {
    return { routeKey, inContention: accuracyUpper > 0, openRoute: true, rank: 0 };
  }
  // A per-case cost the measurement did not record cannot be shown to be unable to compete,
  // so it competes at the pool's cheapest price rather than being ruled out.
  const costUsd = measured.costUsd ?? Math.min(...peers.map(peer => peer.avgCostUsd));
  const hypothesis: ContentionPeer = {
    model: 'hypothesis',
    accuracy: accuracyUpper,
    cases: measured.gradedCases,
    avgCostUsd: costUsd,
  };
  const ranked = rankCandidates(
    [...peers, hypothesis].map(peer => ({ ...peer, p50LatencyMs: null })),
    minAccuracy,
    { accuracyNoiseBand: input.accuracyNoiseBand }
  );
  const rank = ranked.findIndex(candidate => candidate.model === hypothesis.model);
  const floor = minAccuracy - input.accuracyNoiseBand;
  const competing = [...peers, hypothesis].filter(peer => peer.accuracy > 0 && peer.accuracy >= floor);
  const cheapest = competing.reduce<ContentionPeer | null>(
    (best, peer) => (!best || peer.avgCostUsd < best.avgCostUsd ? peer : best),
    null
  );
  const mostAccurate = [...peers, hypothesis].reduce((best, peer) =>
    peer.accuracy > best.accuracy ? peer : best
  );
  const inContention =
    (rank >= 0 && rank < SUBSET_CONTENTION_TOP_K) ||
    cheapest?.model === hypothesis.model ||
    mostAccurate.model === hypothesis.model;
  return { routeKey, inContention, openRoute: false, rank: rank < 0 ? null : rank };
}

export type SubsetVerdict = {
  inContention: boolean;
  routes: RouteContention[];
  /** Subset accuracy over graded rows, repetitions included. */
  accuracy: number;
  /** Upper confidence bound over the subset's distinct cases. */
  accuracyUpper: number;
  graded: number;
  gradedCases: number;
  costUsd: number | null;
  /** The route whose comparison put the pair in contention, when one did. */
  decisiveRoute: TaxonomyRouteKey | null;
};

/**
 * The post-subset decision: measure the rest of the cases when the subset could still win
 * anywhere, otherwise stop. `peersByRoute` is the published table's candidates — the models
 * the pair would have to beat — and a route with no candidates at all is a route any measured
 * pair would lead.
 */
export function subsetVerdict(input: {
  measured: readonly RouteMeasurement[];
  peersByRoute: Readonly<Partial<Record<TaxonomyRouteKey, readonly ContentionPeer[]>>>;
  minAccuracy: number;
  accuracyNoiseBand: number;
}): SubsetVerdict {
  const routes = input.measured.map(measured =>
    routeContention({
      routeKey: measured.routeKey,
      measured,
      peers: input.peersByRoute[measured.routeKey] ?? [],
      minAccuracy: input.minAccuracy,
      accuracyNoiseBand: input.accuracyNoiseBand,
    })
  );
  const totalGraded = input.measured.reduce((sum, measurement) => sum + measurement.graded, 0);
  const totalScore = input.measured.reduce(
    (sum, measurement) => sum + measurement.accuracy * measurement.graded,
    0
  );
  const totalCases = input.measured.reduce((sum, measurement) => sum + measurement.gradedCases, 0);
  const accuracy = totalGraded > 0 ? totalScore / totalGraded : 0;
  const costed = input.measured.filter(measurement => measurement.costUsd !== null);
  const costedGraded = costed.reduce((sum, measurement) => sum + measurement.graded, 0);
  const costUsd =
    costedGraded > 0
      ? costed.reduce((sum, measurement) => sum + (measurement.costUsd ?? 0) * measurement.graded, 0) /
        costedGraded
      : null;
  const decisive = routes.find(route => route.inContention);
  return {
    inContention: decisive !== undefined,
    routes,
    accuracy,
    accuracyUpper: wilsonUpperBound(accuracy, totalCases),
    graded: totalGraded,
    gradedCases: totalCases,
    costUsd,
    decisiveRoute: decisive?.routeKey ?? null,
  };
}

/** What the profile records when a subset stops a pair: enough to read the decision later. */
export const SUBSET_STOP_FAILURE_CLASS = 'subset_not_in_contention' as const;

/**
 * The bounded reason stored on a stopped pair. Names the numbers the decision used, because
 * the admin console shows this text and nothing else about the stop.
 */
export function subsetStopReason(input: {
  subsetCases: number;
  fullCases: number;
  verdict: SubsetVerdict;
  multiplier: number;
  medianUsd: number | null;
}): string {
  const { verdict } = input;
  const money = (value: number | null) => (value === null ? 'unknown' : `$${value.toFixed(4)}`);
  const compared = verdict.routes
    .map(route => `${route.routeKey} ${route.inContention ? 'in contention' : 'out'}`)
    .join('; ');
  return (
    `subset ${input.subsetCases}/${input.fullCases} cases: accuracy ${verdict.accuracy.toFixed(3)} ` +
    `(upper bound ${verdict.accuracyUpper.toFixed(3)}, n=${verdict.graded}), ` +
    `${money(verdict.costUsd)}/case vs pool median ${money(input.medianUsd)} ` +
    `(expensive above ${input.multiplier}x) — no route could be led: ${compared}`
  ).slice(0, 500);
}
