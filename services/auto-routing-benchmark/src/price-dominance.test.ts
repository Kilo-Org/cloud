import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTO_ROUTER,
  type CandidatePricing,
  type RankedCandidate,
  type TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import {
  MIN_LEADER_REPETITIONS,
  evaluatePriceDominance,
  pairIsMeasured,
  pairRequestCostUsd,
  type MeasurementPool,
  type PoolRouteInput,
  type PriceDominanceNumbers,
  type RouteTokenUsage,
} from './price-dominance';

const ROUTE: TaxonomyRouteKey = 'implementation/feature_development';
const PLATFORM: MeasurementPool = { kind: 'platform', id: 'platform' };
const USER_POOL: MeasurementPool = { kind: 'user_subscription', id: 'owner-a' };

/**
 * The incident's prices: Sol's catalog prices, and Astra at 4.5x them. Every number here
 * is a ratio, so the tests stay readable: Sol is the leader, Astra is the expensive model.
 * Usage is one production-sized request; only relative costs matter to the rule.
 */
const SOL_PRICING: CandidatePricing = {
  promptUsdPerToken: 0.000002,
  completionUsdPerToken: 0.00001,
  cacheReadUsdPerToken: 0.0000001,
};
const ASTRA_PRICING: CandidatePricing = {
  promptUsdPerToken: SOL_PRICING.promptUsdPerToken * 4.5,
  completionUsdPerToken: SOL_PRICING.completionUsdPerToken * 4.5,
  cacheReadUsdPerToken: (SOL_PRICING.cacheReadUsdPerToken ?? 0) * 4.5,
};
const USAGE: RouteTokenUsage = {
  avgInputTokens: 9_400,
  avgCachedInputTokens: 0,
  avgOutputTokens: 108,
  avgReasoningTokens: 32,
};
const TOKEN_PROFILE = { uncachedInputTokens: 9_400, cachedInputTokens: 0 };

function candidate(overrides: Partial<RankedCandidate> & { model: string }): RankedCandidate {
  return {
    accuracy: 0.97,
    cases: 90,
    avgCostUsd: 0.04,
    meetsThreshold: true,
    p50LatencyMs: 25_000,
    p50TtftMs: null,
    pricing: SOL_PRICING,
    variant: null,
    ...overrides,
  };
}

function pool(
  measurementPool: MeasurementPool,
  candidates: RankedCandidate[],
  tokenProfile: { uncachedInputTokens: number; cachedInputTokens: number } | null = TOKEN_PROFILE
): PoolRouteInput {
  return { pool: measurementPool, candidates, tokenProfile, tokenUsage: [USAGE] };
}

/** Sol leads the route on the platform: the cheapest model at equal accuracy. */
const SOL_LEADS = candidate({ model: 'openai/gpt-6.2-sol', avgCostUsd: 0.04 });

function expensiveModelVerdict() {
  return evaluatePriceDominance({
    router: DEFAULT_AUTO_ROUTER,
    pair: { model: 'openai/gpt-6.2-astra', variant: 'high', pricing: ASTRA_PRICING },
    pools: [pool(PLATFORM, [SOL_LEADS])],
    leaderRepetitions: 3,
  });
}

describe('efficient: an expensive model that cannot win at 100% accuracy is skipped', () => {
  it('skips a 4.5x model behind a cheaper leader on the same route', () => {
    const verdict = expensiveModelVerdict();
    expect(verdict.kind).toBe('skip');
    expect(verdict.pools).toHaveLength(1);
    expect(verdict.pools[0].kind).toBe('cannot_win');
    // Astra bills 4.5x Sol for the same tokens, so its best conceivable value is worse.
    expect(verdict.numbers.pairRequestCostUsd).toBeCloseTo(
      pairRequestCostUsd(ASTRA_PRICING, USAGE, TOKEN_PROFILE) ?? NaN
    );
    expect(verdict.numbers.pairRequestCostUsd).toBeCloseTo(
      (verdict.numbers.leader?.requestCostUsd ?? 0) * 4.5,
      6
    );
    expect(verdict.numbers.pairBestValue).not.toBeNull();
    expect(verdict.numbers.pairBestValue ?? 0).toBeGreaterThan(verdict.numbers.leader?.value ?? 0);
  });

  it('measures a model cheaper than the leader', () => {
    const verdict = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: { model: 'vendor/cheaper', variant: null, pricing: {
        promptUsdPerToken: SOL_PRICING.promptUsdPerToken / 3,
        completionUsdPerToken: SOL_PRICING.completionUsdPerToken / 3,
        cacheReadUsdPerToken: null,
      } },
      pools: [pool(PLATFORM, [SOL_LEADS])],
      leaderRepetitions: 3,
    });
    expect(verdict.kind).toBe('measure');
    expect(verdict.reason).toBe('could_win');
    expect((verdict.numbers.pairBestValue ?? Infinity) < (verdict.numbers.leader?.value ?? 0)).toBe(
      true
    );
  });
});

describe('unknowns are never dominated', () => {
  it('measures an unpriced pair (-1 sentinel or no catalog price) instead of skipping it', () => {
    const verdict = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: { model: 'vendor/dynamic-price', variant: null, pricing: null },
      pools: [pool(PLATFORM, [SOL_LEADS])],
      leaderRepetitions: 3,
    });
    expect(verdict.kind).toBe('measure');
    expect(verdict.reason).toBe('unknown');
    expect(verdict.pools[0]).toMatchObject({ kind: 'unknown', reason: 'unpriced_pair' });
  });

  it('measures when the pool published no leader on the route', () => {
    const verdict = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: { model: 'openai/gpt-6.2-astra', variant: 'high', pricing: ASTRA_PRICING },
      pools: [pool(PLATFORM, [])],
      leaderRepetitions: 3,
    });
    expect(verdict.kind).toBe('measure');
    expect(verdict.pools[0]).toMatchObject({ kind: 'unknown', reason: 'no_leader' });
  });

  it('measures when the leader rests on fewer than three repetitions (kilocode#16395)', () => {
    const verdict = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: { model: 'openai/gpt-6.2-astra', variant: 'high', pricing: ASTRA_PRICING },
      pools: [pool(PLATFORM, [SOL_LEADS])],
      leaderRepetitions: MIN_LEADER_REPETITIONS - 1,
    });
    expect(verdict.kind).toBe('measure');
    expect(verdict.pools[0]).toMatchObject({
      kind: 'unknown',
      reason: 'leader_repetitions_below_minimum',
    });
  });

  it('measures a pair with no pool at all rather than treating silence as dominance', () => {
    const verdict = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: { model: 'openai/gpt-6.2-astra', variant: 'high', pricing: ASTRA_PRICING },
      pools: [],
      leaderRepetitions: 3,
    });
    expect(verdict.kind).toBe('measure');
  });
});

describe('frontier: a pair above the route budget is skipped', () => {
  const FRONTIER_LEADER = candidate({
    model: 'openai/gpt-6.2-sol',
    accuracy: 0.93,
    avgCostUsd: 0.05,
  });

  it('skips a pair priced above the dearest candidate the pool serves', () => {
    const verdict = evaluatePriceDominance({
      router: 'frontier',
      pair: { model: 'openai/gpt-6.2-astra', variant: 'high', pricing: ASTRA_PRICING },
      pools: [pool(PLATFORM, [FRONTIER_LEADER])],
      leaderRepetitions: 1,
    });
    expect(verdict.kind).toBe('skip');
    expect(verdict.numbers.budgetUsd).toBeCloseTo(0.05, 6);
    expect(verdict.numbers.pairRequestCostUsd ?? 0).toBeGreaterThan(verdict.numbers.budgetUsd ?? 0);
  });

  it('measures a pair inside the budget even when it is dearer than the leader', () => {
    const verdict = evaluatePriceDominance({
      router: 'frontier',
      pair: {
        model: 'vendor/inside-budget',
        variant: null,
        pricing: {
          promptUsdPerToken: SOL_PRICING.promptUsdPerToken * 2,
          completionUsdPerToken: SOL_PRICING.completionUsdPerToken * 2,
          cacheReadUsdPerToken: null,
        },
      },
      pools: [
        pool(PLATFORM, [
          FRONTIER_LEADER,
          candidate({ model: 'vendor/dear-served', avgCostUsd: 0.5 }),
        ]),
      ],
      leaderRepetitions: 1,
    });
    // The budget is the dearest SERVED candidate, not the leader: 0.5 here.
    expect(verdict.numbers.budgetUsd).toBeCloseTo(0.5, 6);
    expect(verdict.kind).toBe('measure');
  });
});

describe('dominance is relative to the pool a measurement serves', () => {
  it('skips a model that loses on the platform but measures it for a pool where it can lead', () => {
    // Platform: Sol leads, Astra is 4.5x and cannot win.
    // The owner's pool holds Astra alone, so it is that pool's only option.
    const verdict = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: { model: 'openai/gpt-6.2-astra', variant: 'high', pricing: ASTRA_PRICING },
      pools: [pool(PLATFORM, [SOL_LEADS]), pool(USER_POOL, [])],
      leaderRepetitions: 3,
    });
    expect(verdict.kind).toBe('measure');
    expect(verdict.reason).toBe('unknown');
    expect(verdict.pools.map(pool => pool.kind)).toEqual(['cannot_win', 'unknown']);
  });

  it('measures a pair shared by two pools when it can win in one of them', () => {
    const verdict = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: { model: 'openai/gpt-6.2-astra', variant: 'high', pricing: ASTRA_PRICING },
      pools: [
        pool(PLATFORM, [SOL_LEADS]),
        // The owner's pool serves only dearer models, so Astra leads it.
        pool(USER_POOL, [
          candidate({ model: 'vendor/dear-pool-model', pricing: ASTRA_PRICING, avgCostUsd: 1.2 }),
        ]),
      ],
      leaderRepetitions: 3,
    });
    expect(verdict.kind).toBe('measure');
    expect(verdict.reason).toBe('could_win');
    expect(verdict.pools.map(pool => pool.kind)).toEqual(['cannot_win', 'could_win']);
  });

  it('measures a pool of only expensive models instead of skipping it empty', () => {
    const verdict = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: { model: 'openai/gpt-6.2-astra', variant: 'max', pricing: ASTRA_PRICING },
      pools: [pool(USER_POOL, [])],
      leaderRepetitions: 3,
    });
    expect(verdict.kind).toBe('measure');
    expect(pairIsMeasured([{ routeKey: ROUTE, verdict }])).toBe(true);
  });

  it('skips only when every pool that includes the pair returns cannot_win', () => {
    const verdict = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: { model: 'openai/gpt-6.2-astra', variant: 'high', pricing: ASTRA_PRICING },
      pools: [pool(PLATFORM, [SOL_LEADS]), pool(USER_POOL, [SOL_LEADS])],
      leaderRepetitions: 3,
    });
    expect(verdict.kind).toBe('skip');
    expect(verdict.pools.every(pool => pool.kind === 'cannot_win')).toBe(true);
  });
});

describe('re-evaluation when the leader or the price moves', () => {
  it('keeps the same pair eligible once a dearer model becomes the leader', () => {
    const astra = { model: 'openai/gpt-6.2-astra', variant: 'high', pricing: ASTRA_PRICING };
    const before = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: astra,
      pools: [pool(PLATFORM, [SOL_LEADS])],
      leaderRepetitions: 3,
    });
    expect(before.kind).toBe('skip');

    // The leader moves: the platform now ranks a model priced above Astra first.
    const after = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: astra,
      pools: [
        pool(PLATFORM, [
          candidate({
            model: 'vendor/new-leader',
            pricing: {
              promptUsdPerToken: ASTRA_PRICING.promptUsdPerToken * 2,
              completionUsdPerToken: ASTRA_PRICING.completionUsdPerToken * 2,
              cacheReadUsdPerToken: null,
            },
            avgCostUsd: 0.4,
          }),
        ]),
      ],
      leaderRepetitions: 3,
    });
    expect(after.kind).toBe('measure');
  });

  it('keeps the same leader but re-opens when the pair gets cheaper', () => {
    const verdict = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: {
        model: 'openai/gpt-6.2-astra',
        variant: 'high',
        pricing: {
          promptUsdPerToken: SOL_PRICING.promptUsdPerToken / 2,
          completionUsdPerToken: SOL_PRICING.completionUsdPerToken / 2,
          cacheReadUsdPerToken: null,
        },
      },
      pools: [pool(PLATFORM, [SOL_LEADS])],
      leaderRepetitions: 3,
    });
    expect(verdict.kind).toBe('measure');
  });
});

describe('pair-level answer', () => {
  it('measures the pair when any single route keeps it', () => {
    const skipped = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: { model: 'openai/gpt-6.2-astra', variant: 'high', pricing: ASTRA_PRICING },
      pools: [pool(PLATFORM, [SOL_LEADS])],
      leaderRepetitions: 3,
    });
    const kept = evaluatePriceDominance({
      router: DEFAULT_AUTO_ROUTER,
      pair: { model: 'openai/gpt-6.2-astra', variant: 'high', pricing: ASTRA_PRICING },
      pools: [pool(PLATFORM, [])],
      leaderRepetitions: 3,
    });
    expect(
      pairIsMeasured([
        { routeKey: ROUTE, verdict: skipped },
        { routeKey: 'debugging/bug_fixing', verdict: kept },
      ])
    ).toBe(true);
    expect(
      pairIsMeasured([
        { routeKey: ROUTE, verdict: skipped },
        { routeKey: 'debugging/bug_fixing', verdict: skipped },
      ])
    ).toBe(false);
    expect(pairIsMeasured([])).toBe(true);
  });
});

describe('pricing', () => {
  it('prices from measured tokens and falls back to the pool profile', () => {
    const exact = pairRequestCostUsd(ASTRA_PRICING, USAGE, null);
    const profiled = pairRequestCostUsd(ASTRA_PRICING, null, TOKEN_PROFILE);
    expect(exact).not.toBeNull();
    expect(profiled).not.toBeNull();
    // Measured usage reports 108 output + 32 reasoning tokens; the profile carries input only.
    expect(profiled).toBeGreaterThan(0);
    expect(exact).toBeGreaterThan(profiled);
  });

  it('returns null rather than a guessed price without pricing or a profile', () => {
    expect(pairRequestCostUsd(null, USAGE, TOKEN_PROFILE)).toBeNull();
    expect(pairRequestCostUsd(ASTRA_PRICING, null, null)).toBeNull();
  });
});
