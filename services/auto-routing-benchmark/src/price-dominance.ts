import {
  effectiveLatencyMs,
  estimateRequestCostUsd,
  linkedAvgCostUsd,
  rankValue,
  type CandidatePricing,
  type ProductionTokenProfile,
  type RankedCandidate,
  type RoutingTable,
  type TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';

/**
 * Price-dominance pruning: decide, before a `(model, variant, route)` pair is measured,
 * whether it could win that route's published ranking at all (lever 1 of the benchmark
 * cost work).
 *
 * The question is always asked against ONE POOL: the platform decider list, or one
 * owner's custom pool. A model that cannot win on the platform can still be the leader,
 * or the only entry, of a user pool, so a pair is only skipped when it loses in every
 * pool that includes it.
 *
 * Two rules, one per router objective (ADR 0002 and the README's "Objectives"):
 *
 * - Efficient minimizes cost per unit of accuracy, so a pair loses when its BEST
 *   conceivable showing — 100% accuracy at the fastest latency any candidate on the
 *   route was measured at — still ranks behind that pool's leader under `rankValue`.
 *   Accuracy enters that value only as `accuracy^15`, so a lower accuracy can never
 *   improve a candidate's value: beating 100% is impossible.
 * - Frontier maximizes accuracy inside a frozen cost bound, so price alone decides. The
 *   bound is the pool's own published route: the dearest candidate it already serves is
 *   the most the router commits per request on that route, and a pair priced above it
 *   cannot be published without raising that commitment.
 *
 * Unknown is never dominated. A pair with no catalog price, a pool with no published
 * leader on the route, or a leader whose measurement cannot be ranked all resolve to
 * `measure`, because the outcome is uncertain. So does a leader measured with fewer than
 * the efficient router's three repetitions: kilocode#16395 says a route lead may not rest
 * on fewer.
 */

/** The router a pool belongs to. Both routers use their objective's rule. */
export type PriceDominanceRouter = 'efficient' | 'frontier';

/** Who a measurement serves. Named by type only: owner ids never reach public text. */
export type MeasurementPoolKind = 'platform' | 'user_subscription' | 'custom';

export type MeasurementPool = {
  kind: MeasurementPoolKind;
  /** Stable per-pool identity for the stored row and the console. Never shown publicly. */
  id: string;
};

/** Measured mean tokens of one candidate on one route, as `model_summaries` stores them. */
export type RouteTokenUsage = {
  avgInputTokens: number;
  avgCachedInputTokens: number;
  avgOutputTokens: number;
  avgReasoningTokens: number;
};

export type PoolRouteInput = {
  pool: MeasurementPool;
  /** The pool's published candidates for this route, best first. Empty means no bound. */
  candidates: readonly RankedCandidate[];
  /** Token profile the pool prices requests with; null when the pool has none. */
  tokenProfile: ProductionTokenProfile | null;
  /** Measured token means of the pool's candidates on this route, for exact repricing. */
  tokenUsage: readonly RouteTokenUsage[];
};

export type PriceDominanceInput = {
  router: PriceDominanceRouter;
  /** The pair under consideration. `pricing` is null when the catalog cannot price it. */
  pair: { model: string; variant: string | null; pricing: CandidatePricing | null };
  /** Every pool that would be served by measuring this pair. */
  pools: readonly PoolRouteInput[];
  /** Repetitions the leader was measured with; the efficient router requires at least 3. */
  leaderRepetitions: number;
};

/** Numbers behind a verdict, stored with it and shown in the console. */
export type PriceDominanceNumbers = {
  /** The pair's estimated request cost on this route, USD. Null when it cannot be priced. */
  pairRequestCostUsd: number | null;
  /** The leader of the pool that decided the verdict. Null when that pool has no leader. */
  leader: {
    model: string;
    variant: string | null;
    requestCostUsd: number;
    /** The leader's `rankValue`: lower wins. Null when it cannot be ranked. */
    value: number | null;
    accuracy: number;
  } | null;
  /** Frontier budget (the dearest served candidate's request cost). Null for efficient. */
  budgetUsd: number | null;
  /** The pair's best conceivable `rankValue` at 100% accuracy. Null for frontier. */
  pairBestValue: number | null;
};

export type PoolUnknownReason =
  /** The pool published no candidate on this route yet, so it has no bound to beat. */
  | 'no_leader'
  /** The catalog cannot price the pair, so neither rule can compare it. */
  | 'unpriced_pair'
  /** The efficient leader was measured fewer than three times (kilocode#16395). */
  | 'leader_repetitions_below_minimum'
  /** The leader cannot be ranked (infinite value), so it is not a bound. */
  | 'leader_unrankable';

export type PoolVerdict =
  | { pool: MeasurementPool; kind: 'cannot_win'; numbers: PriceDominanceNumbers }
  | { pool: MeasurementPool; kind: 'could_win'; numbers: PriceDominanceNumbers }
  | {
      pool: MeasurementPool;
      kind: 'unknown';
      reason: PoolUnknownReason;
      numbers: PriceDominanceNumbers;
    };

export type PriceDominanceVerdict =
  | {
      kind: 'measure';
      /** Why at least one pool kept the pair. */
      reason: 'could_win' | 'unknown';
      pools: readonly PoolVerdict[];
      numbers: PriceDominanceNumbers;
    }
  | {
      kind: 'skip';
      reason: 'dominated_in_every_pool';
      pools: readonly PoolVerdict[];
      numbers: PriceDominanceNumbers;
    };

/** Efficient may not conclude dominance from a route lead measured fewer than three times (kilocode#16395). */
export const MIN_LEADER_REPETITIONS = 3;

/** Efficient's value formula divides by `accuracy^15`, so a candidate that loses at 1.0 loses at every accuracy. */
const BEST_CASE_ACCURACY = 1;

/** Fastest latency any candidate on the route was measured at; the best a newcomer could show. */
function latencyFloorMs(candidates: readonly RankedCandidate[]): number | null {
  let floor: number | null = null;
  for (const candidate of candidates) {
    const latency = effectiveLatencyMs(candidate);
    if (latency === null) continue;
    if (floor === null || latency < floor) floor = latency;
  }
  return floor;
}

/**
 * The route's measured token usage: the mean over the pool's candidates on this route that
 * reported every token category. Null when none did, which sends the pricing to the pool's
 * configured production profile instead.
 */
function routeTokenUsage(summaries: readonly RouteTokenUsage[]): RouteTokenUsage | null {
  if (summaries.length === 0) return null;
  const sum = summaries.reduce(
    (total, summary) => ({
      avgInputTokens: total.avgInputTokens + summary.avgInputTokens,
      avgCachedInputTokens: total.avgCachedInputTokens + summary.avgCachedInputTokens,
      avgOutputTokens: total.avgOutputTokens + summary.avgOutputTokens,
      avgReasoningTokens: total.avgReasoningTokens + summary.avgReasoningTokens,
    }),
    { avgInputTokens: 0, avgCachedInputTokens: 0, avgOutputTokens: 0, avgReasoningTokens: 0 }
  );
  return {
    avgInputTokens: sum.avgInputTokens / summaries.length,
    avgCachedInputTokens: sum.avgCachedInputTokens / summaries.length,
    avgOutputTokens: sum.avgOutputTokens / summaries.length,
    avgReasoningTokens: sum.avgReasoningTokens / summaries.length,
  };
}

/**
 * The pair's estimated request cost on one route. Reuses the routing table's own repricing
 * (`linkedAvgCostUsd`, which reprices a measurement at a pool's prices) so the number
 * compared against the leader is the one the ranking itself would use.
 */
export function pairRequestCostUsd(
  pricing: CandidatePricing | null,
  usage: RouteTokenUsage | null,
  tokenProfile: ProductionTokenProfile | null
): number | null {
  if (pricing === null) return null;
  // The platform pricing term is unused on linkedAvgCostUsd's exact-token branch.
  if (usage !== null) return linkedAvgCostUsd({ avgCostUsd: 0, ...usage }, pricing, null);
  if (tokenProfile === null) return null;
  return estimateRequestCostUsd({ avgCostUsd: 0, pricing }, tokenProfile);
}

function evaluatePool(input: PriceDominanceInput, pool: PoolRouteInput): PoolVerdict {
  const leader = pool.candidates[0] ?? null;
  const pairCost = pairRequestCostUsd(
    input.pair.pricing,
    routeTokenUsage(pool.tokenUsage),
    pool.tokenProfile
  );
  const numbers: PriceDominanceNumbers = {
    pairRequestCostUsd: pairCost,
    leader: null,
    budgetUsd: null,
    pairBestValue: null,
  };
  if (leader === null) {
    return { pool: pool.pool, kind: 'unknown', reason: 'no_leader', numbers };
  }
  const leaderValue = rankValue({
    accuracy: leader.accuracy,
    cases: leader.cases ?? null,
    avgCostUsd: leader.estimatedRequestCostUsd ?? leader.avgCostUsd,
    p50LatencyMs: leader.p50LatencyMs ?? null,
    p50TtftMs: leader.p50TtftMs,
  });
  numbers.leader = {
    model: leader.model,
    variant: leader.variant ?? null,
    requestCostUsd: leader.estimatedRequestCostUsd ?? leader.avgCostUsd,
    value: Number.isFinite(leaderValue) ? leaderValue : null,
    accuracy: leader.accuracy,
  };

  if (input.router === 'frontier') {
    // The pool's published route is its cost commitment: the dearest candidate it serves is
    // the most the router will spend per request on this route, and the frontier objective
    // may not raise it. A pair priced above that cannot be published.
    let budget = 0;
    for (const candidate of pool.candidates) {
      const cost = candidate.estimatedRequestCostUsd ?? candidate.avgCostUsd;
      if (cost > budget) budget = cost;
    }
    numbers.budgetUsd = budget;
    if (pairCost === null) {
      return { pool: pool.pool, kind: 'unknown', reason: 'unpriced_pair', numbers };
    }
    return pairCost > budget
      ? { pool: pool.pool, kind: 'cannot_win', numbers }
      : { pool: pool.pool, kind: 'could_win', numbers };
  }

  if (input.leaderRepetitions < MIN_LEADER_REPETITIONS) {
    return {
      pool: pool.pool,
      kind: 'unknown',
      reason: 'leader_repetitions_below_minimum',
      numbers,
    };
  }
  if (pairCost === null) {
    return { pool: pool.pool, kind: 'unknown', reason: 'unpriced_pair', numbers };
  }
  const floorMs = latencyFloorMs(pool.candidates);
  numbers.pairBestValue = rankValue({
    accuracy: BEST_CASE_ACCURACY,
    cases: null,
    avgCostUsd: pairCost,
    p50LatencyMs: floorMs,
    // With no measured latency on the route the ranking compares without the latency term,
    // which is exactly what the leader's published value already reflects.
    ignoreLatency: floorMs === null,
  });
  if (!Number.isFinite(numbers.pairBestValue) || numbers.leader.value === null) {
    return { pool: pool.pool, kind: 'unknown', reason: 'leader_unrankable', numbers };
  }
  return numbers.pairBestValue < numbers.leader.value
    ? { pool: pool.pool, kind: 'could_win', numbers }
    : { pool: pool.pool, kind: 'cannot_win', numbers };
}

/**
 * Decide one `(model, variant, route)`. A pair is skipped only when every pool that includes
 * it returns `cannot_win`; one `could_win` or one `unknown` pool is enough to measure it.
 */
export function evaluatePriceDominance(input: PriceDominanceInput): PriceDominanceVerdict {
  if (input.pools.length === 0) {
    return {
      kind: 'measure',
      reason: 'unknown',
      pools: [],
      numbers: { pairRequestCostUsd: null, leader: null, budgetUsd: null, pairBestValue: null },
    };
  }
  const pools = input.pools.map(pool => evaluatePool(input, pool));
  const kept = pools.find(verdict => verdict.kind !== 'cannot_win');
  if (kept) {
    return {
      kind: 'measure',
      reason: kept.kind === 'could_win' ? 'could_win' : 'unknown',
      pools,
      numbers: kept.numbers,
    };
  }
  return { kind: 'skip', reason: 'dominated_in_every_pool', pools, numbers: pools[0].numbers };
}

/**
 * A pair is measured when it can win on at least one route of at least one pool. The
 * per-route verdicts are recorded for the console; only this pair-level answer decides
 * whether the benchmark measures the pair at all.
 */
export function pairIsMeasured(
  verdicts: readonly { routeKey: TaxonomyRouteKey; verdict: PriceDominanceVerdict }[]
): boolean {
  if (verdicts.length === 0) return true;
  return verdicts.some(entry => entry.verdict.kind === 'measure');
}

/** The published candidates of one route of one table, or an empty list. */
export function routeCandidates(
  table: RoutingTable | null,
  routeKey: TaxonomyRouteKey
): readonly RankedCandidate[] {
  return table?.routes[routeKey] ?? [];
}
