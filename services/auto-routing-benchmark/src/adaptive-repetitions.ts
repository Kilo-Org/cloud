import type { RankedCandidate, TaxonomyRouteKey } from '@kilocode/auto-routing-contracts';

/**
 * Repetitions a pair needs before it may take a route lead (#16395): one
 * repetition's accuracy is noise, and a model that won a route on one lucky run
 * stopped to narrate in production. The route head is always measured at least
 * this many times before it is published as the leader.
 */
export const MIN_LEAD_REPS = 3;

/**
 * Where a pair stands in its repetition plan. Stored per run entry so the admin
 * console can say why a pair was measured once (or three times) without
 * recomputing the decision.
 *
 * - `provisional`: repetitions started, nothing settled yet.
 * - `escalated`: near a ranking boundary or a would-be leader, so the remaining
 *   repetitions run.
 * - `complete`: the repetitions measured settled it.
 * - `stopped`: dominated — its upper bound is below the leader on every route it
 *   competes on, so no repetition can change a published leader.
 */
export const PAIR_REPETITION_STATES = [
  'provisional',
  'escalated',
  'complete',
  'stopped',
] as const;
export type PairRepetitionState = (typeof PAIR_REPETITION_STATES)[number];

/** One route's measurement for a pair, over the repetitions measured so far. */
export type RouteMeasurement = {
  routeKey: TaxonomyRouteKey;
  /** Mean score over every measured row (an error scores 0), matching `summarize`. */
  accuracy: number;
  /** Distinct graded cases: the sample size one repetition contributes. */
  cases: number;
};

/**
 * Wilson score interval at the z the ranker already uses for its small-sample
 * bound (z = 1), so a decision here and a ranking there differ only by design.
 */
export function wilsonInterval(
  accuracy: number,
  n: number,
  zScore = 1
): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const z2 = zScore * zScore;
  const denominator = 1 + z2 / n;
  const center = accuracy + z2 / (2 * n);
  const margin = zScore * Math.sqrt((accuracy * (1 - accuracy) + z2 / (4 * n)) / n);
  return {
    low: Math.max(0, (center - margin) / denominator),
    high: Math.min(1, (center + margin) / denominator),
  };
}

export type RepetitionDecision =
  | { state: 'complete'; routes: string[] }
  | { state: 'stopped'; routes: string[] }
  | { state: 'escalated'; routes: string[]; reason: 'boundary' | 'lead'; requiredReps: number };

export type DecideRepetitionPlanInput = {
  routes: readonly RouteMeasurement[];
  /**
   * Accuracy the pair must beat on each route: the live leader where the table
   * serves the route, else the run's strongest other pair. Absent for a route no
   * other pair measured.
   */
  target: ReadonlyMap<string, number>;
  minAccuracy: number;
  accuracyNoiseBand: number;
  /** Repetitions already measured for this pair. */
  measuredReps: number;
  /** Repetitions a boundary pair is measured to: the router's own count. */
  boundaryTargetReps: number;
  /**
   * Repetitions a pair needs before it may head a route (#16395). Never below
   * one, and never above what the run's target allows unless the policy itself
   * measures fewer — a leader must still clear `MIN_LEAD_REPS`.
   */
  leadTargetReps: number;
};

/**
 * One pair's repetition plan after the repetitions so far. Pure: the caller
 * supplies the measurements the run holds, the accuracy to beat per route, and
 * the ranking knobs.
 *
 * Rules, most specific first:
 *  1. Already at the repetitions a boundary pair is measured to: settled.
 *  2. Beats the route's leader on what it has: it may not lead until it has
 *     `leadTargetReps`, so schedule them (`reason: 'lead'`).
 *  3. Within the noise band of the leader or of the accuracy cutoff the ranker
 *     uses: another repetition can move it either way (`reason: 'boundary'`).
 *  4. Dominated on every route it competes on — its upper bound stays below the
 *     leader — so no extra repetition can change a published leader.
 *  5. Otherwise the one repetition settles it.
 */
export function decideRepetitionPlan(input: DecideRepetitionPlanInput): RepetitionDecision {
  const routes = input.routes.map(route => route.routeKey);
  if (input.routes.length === 0) return { state: 'complete', routes };
  // A pair that would head a route may not do so on fewer repetitions than a
  // route lead requires (#16395), whatever the router's own count is.
  const leading = input.routes.find(
    route => input.target.get(route.routeKey) === undefined || route.accuracy > (input.target.get(route.routeKey) ?? 0)
  );
  if (leading && input.measuredReps < input.leadTargetReps) {
    return {
      state: 'escalated',
      routes: [leading.routeKey],
      reason: 'lead',
      requiredReps: input.leadTargetReps,
    };
  }
  if (input.measuredReps >= input.boundaryTargetReps) return { state: 'complete', routes };
  const contested: string[] = [];
  const dominated: string[] = [];
  for (const route of input.routes) {
    const target = input.target.get(route.routeKey);
    if (target === undefined) continue;
    const interval = wilsonInterval(route.accuracy, route.cases);
    const nearTarget =
      interval.low <= target + input.accuracyNoiseBand &&
      interval.high >= target - input.accuracyNoiseBand;
    const nearCutoff =
      interval.low <= input.minAccuracy + input.accuracyNoiseBand &&
      interval.high >= input.minAccuracy - input.accuracyNoiseBand;
    if (nearTarget || nearCutoff) contested.push(route.routeKey);
    // Its best-case accuracy still trails the leader: no repetition of this pair
    // can change which model leads the route.
    else if (interval.high + input.accuracyNoiseBand < target) dominated.push(route.routeKey);
  }
  if (contested.length > 0) {
    return {
      state: 'escalated',
      routes: contested,
      reason: 'boundary',
      requiredReps: input.boundaryTargetReps,
    };
  }
  if (dominated.length === input.routes.length) {
    return { state: 'stopped', routes: dominated };
  }
  return { state: 'complete', routes };
}

/**
 * Group a pair's graded rows into per-route measurements: mean score over every
 * row (an error counts as 0, as `summarize` does) and the distinct case count of
 * one repetition, never the sum over repetitions.
 */
export function measureRoutes(
  rows: readonly { routeKey: string | null; caseId: string; score: number }[]
): RouteMeasurement[] {
  const byRoute = new Map<string, { score: number; cases: Set<string> }>();
  for (const row of rows) {
    if (row.routeKey === null) continue;
    const bucket = byRoute.get(row.routeKey) ?? { score: 0, cases: new Set<string>() };
    bucket.score += row.score;
    bucket.cases.add(row.caseId);
    byRoute.set(row.routeKey, bucket);
  }
  return [...byRoute].map(([routeKey, bucket]) => ({
    routeKey: routeKey as TaxonomyRouteKey,
    accuracy: bucket.score / Math.max(1, bucket.cases.size),
    cases: bucket.cases.size,
  }));
}

export function pairKey(model: string, variant: string | null): string {
  return JSON.stringify([model, variant]);
}

export type LeadProtectionResult = {
  routes: Record<string, RankedCandidate[]>;
  /** Pairs that would have led but lack the repetitions to do so. */
  demoted: Array<{ routeKey: string; model: string; variant: string | null }>;
};

/**
 * Keep a pair measured fewer than `minLeadReps` times off the head of every
 * route. A route keeps its previous leader meanwhile: the best-ranked candidate
 * that has the repetitions, else the previous published route, else — a first
 * measurement of a whole route — the ranking as it stands.
 */
export function enforceLeadProtection(params: {
  routes: Record<string, RankedCandidate[]>;
  previousRoutes?: Record<string, RankedCandidate[]> | undefined;
  measuredReps: ReadonlyMap<string, number>;
  minLeadReps: number;
}): LeadProtectionResult {
  const routes: Record<string, RankedCandidate[]> = {};
  const demoted: LeadProtectionResult['demoted'] = [];
  for (const [routeKey, candidates] of Object.entries(params.routes)) {
    const head = candidates[0];
    const headReps =
      head === undefined
        ? 0
        : (params.measuredReps.get(pairKey(head.model, head.variant ?? null)) ?? 0);
    if (head === undefined || headReps >= params.minLeadReps) {
      routes[routeKey] = candidates;
      continue;
    }
    demoted.push({ routeKey, model: head.model, variant: head.variant ?? null });
    const eligible = candidates.findIndex(
      candidate =>
        (params.measuredReps.get(pairKey(candidate.model, candidate.variant ?? null)) ?? 0) >=
        params.minLeadReps
    );
    const previous = params.previousRoutes?.[routeKey] ?? [];
    if (eligible > 0) {
      routes[routeKey] = [
        candidates[eligible],
        ...candidates.filter((_, index) => index !== eligible),
      ];
    } else if (previous.length > 0) {
      routes[routeKey] = previous;
    } else {
      routes[routeKey] = candidates;
    }
  }
  return { routes, demoted };
}

/** Console label for a pair's repetition plan. */
export function describeRepetitionState(
  state: PairRepetitionState | null,
  repetitions: number
): string {
  const counted = repetitions === 1 ? '1 rep' : `${repetitions} reps`;
  switch (state) {
    case null:
    case 'provisional':
      return counted;
    case 'escalated':
      return `${counted} · boundary`;
    case 'complete':
      return `${counted} · complete`;
    case 'stopped':
      return `${counted} · stopped (dominated)`;
  }
}
