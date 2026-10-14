import { describe, expect, it } from 'vitest';
import {
  CustomRoutingTableSchema,
  EfficientModelPoolSchema,
  MAX_POOL_ENTRIES,
  poolEntryKey,
  rankCandidates,
  RankedCandidateSchema,
  RoutingTableSchema,
  wilsonLowerBound,
} from './routing-table';

const candidate = (model: string, accuracy: number, avgCostUsd: number) => ({
  model,
  accuracy,
  avgCostUsd,
  meetsThreshold: false,
});

const rankInput = (
  model: string,
  accuracy: number,
  avgCostUsd: number,
  p50LatencyMs: number | null = 10_000
) => ({ model, accuracy, avgCostUsd, p50LatencyMs });

const order = (ranked: { model: string }[]) => ranked.map(c => c.model);

describe('wilsonLowerBound', () => {
  it('returns zero when no cases were measured', () => {
    expect(wilsonLowerBound(1, 0)).toBe(0);
    expect(wilsonLowerBound(1, -1)).toBe(0);
  });

  it('matches known score bounds and supports a custom z score', () => {
    expect(wilsonLowerBound(1, 10)).toBeCloseTo(10 / 11, 10);
    expect(wilsonLowerBound(0, 10)).toBe(0);
    expect(wilsonLowerBound(0.5, 1)).toBeCloseTo((1 - Math.SQRT1_2) / 2, 10);
    expect(wilsonLowerBound(1, 10, 2)).toBeCloseTo(10 / 14, 10);
    expect(wilsonLowerBound(0.7, 10, 0)).toBe(0.7);
  });
});

describe('rankCandidates', () => {
  it('uses first-token latency to break an equal-cost and total-latency tie', () => {
    const ranked = rankCandidates(
      [
        { ...rankInput('slow-first-token', 1, 0.01, 1000), p50TtftMs: 400 },
        { ...rankInput('fast-first-token', 1, 0.01, 1000), p50TtftMs: 100 },
      ],
      0.95
    );
    expect(order(ranked)).toEqual(['fast-first-token', 'slow-first-token']);
    expect(ranked[0].p50TtftMs).toBe(100);
  });

  it('keeps total-latency ordering when first-token latency is unknown', () => {
    const candidates = [
      rankInput('slow-total', 1, 0.01, 2000),
      rankInput('fast-total', 1, 0.01, 1000),
    ];
    expect(order(rankCandidates(candidates, 0.95))).toEqual(['fast-total', 'slow-total']);
    expect(order(rankCandidates(candidates.map(c => ({ ...c, p50TtftMs: null })), 0.95))).toEqual(
      ['fast-total', 'slow-total']
    );
  });

  it('prefers more measured cases when raw accuracy, latency and cost match', () => {
    const ranked = rankCandidates(
      [
        { ...rankInput('small-sample', 1, 0.01), cases: 10 },
        { ...rankInput('large-sample', 1, 0.01), cases: 100 },
      ],
      0.95
    );
    expect(order(ranked)).toEqual(['large-sample', 'small-sample']);
    expect(ranked.map(c => c.cases)).toEqual([100, 10]);
    expect(ranked.every(c => c.meetsThreshold)).toBe(true);
  });

  it('prefers a well-measured candidate even when its raw accuracy is slightly lower', () => {
    expect(
      order(
        rankCandidates(
          [
            { ...rankInput('small-sample', 1, 0.01), cases: 10 },
            { ...rankInput('large-sample', 0.98, 0.01), cases: 100 },
          ],
          0.95
        )
      )
    ).toEqual(['large-sample', 'small-sample']);
  });

  it('preserves raw-accuracy value ordering when case counts are unknown', () => {
    const candidates = [rankInput('accurate', 1, 0.002), rankInput('in-band-cheaper', 0.9, 0.0005)];
    expect(order(rankCandidates(candidates, 0.95))).toEqual(['accurate', 'in-band-cheaper']);
    expect(
      order(
        rankCandidates(
          candidates.map(c => ({ ...c, cases: null })),
          0.95
        )
      )
    ).toEqual(['accurate', 'in-band-cheaper']);
  });

  it('uses raw accuracy for the competing set and strict threshold flag', () => {
    const ranked = rankCandidates(
      [
        { ...rankInput('below-band', 0.89, 0.000001), cases: 1000 },
        { ...rankInput('meets', 1, 0.01), cases: 1 },
      ],
      0.95
    );
    expect(order(ranked)).toEqual(['meets', 'below-band']);
    expect(ranked.map(c => c.meetsThreshold)).toEqual([true, false]);
  });

  it('uses production prompt cost only when a profile is configured', () => {
    const candidates = [
      {
        ...rankInput('cheap-output', 1, 0.01),
        pricing: {
          promptUsdPerToken: 0.002,
          completionUsdPerToken: 0.003,
          cacheReadUsdPerToken: 0.001,
        },
      },
      {
        ...rankInput('cheap-prompt', 1, 0.02),
        pricing: {
          promptUsdPerToken: 0.0002,
          completionUsdPerToken: 0.003,
          cacheReadUsdPerToken: 0.0001,
        },
      },
    ];
    expect(order(rankCandidates(candidates, 0.9, { profile: null }))).toEqual([
      'cheap-output',
      'cheap-prompt',
    ]);
    const ranked = rankCandidates(candidates, 0.9, {
      profile: { uncachedInputTokens: 20, cachedInputTokens: 80 },
    });
    expect(order(ranked)).toEqual(['cheap-prompt', 'cheap-output']);
    expect(ranked[0].estimatedRequestCostUsd).toBeCloseTo(0.032);
  });

  it('falls back to observed cost without pricing and prompt price without cache pricing', () => {
    const ranked = rankCandidates(
      [
        rankInput('unpriced', 1, 0.01),
        {
          ...rankInput('priced', 1, 0.001),
          pricing: {
            promptUsdPerToken: 0.002,
            completionUsdPerToken: 0.003,
            cacheReadUsdPerToken: null,
          },
        },
      ],
      0.9,
      { profile: { uncachedInputTokens: 20, cachedInputTokens: 80 } }
    );
    expect(order(ranked)).toEqual(['unpriced', 'priced']);
    expect(ranked[0].estimatedRequestCostUsd).toBe(0.01);
    expect(ranked[1].estimatedRequestCostUsd).toBeCloseTo(0.201);
  });

  it('puts the best-value competing candidate first and the rest by accuracy', () => {
    const ranked = rankCandidates(
      [
        rankInput('lower-raw-cost', 0.7, 0.007),
        rankInput('better-value', 0.9, 0.008),
        rankInput('weak', 0.5, 0.001),
      ],
      0.7
    );
    expect(order(ranked)).toEqual(['better-value', 'lower-raw-cost', 'weak']);
    expect(ranked[0].meetsThreshold).toBe(true);
    expect(ranked[2].meetsThreshold).toBe(false);
    expect(ranked[0].p50LatencyMs).toBe(10_000);
  });
  it('prefers a faster candidate over a slightly cheaper slow one', () => {
    const ranked = rankCandidates(
      [rankInput('cheap-slow', 1, 0.0013, 28_000), rankInput('fast', 1, 0.0017, 11_000)],
      0.95
    );
    expect(order(ranked)).toEqual(['fast', 'cheap-slow']);
  });
  it('lets a candidate inside the noise band compete without marking it as meeting the threshold', () => {
    const ranked = rankCandidates(
      [rankInput('meets', 1, 0.006), rankInput('in-band', 0.9, 0.001)],
      0.95
    );
    expect(order(ranked)).toEqual(['in-band', 'meets']);
    expect(ranked[0].meetsThreshold).toBe(false);
    expect(ranked[1].meetsThreshold).toBe(true);
  });
  it('keeps a candidate below the noise band behind every competing candidate', () => {
    const ranked = rankCandidates(
      [rankInput('meets', 1, 0.01), rankInput('below-band', 0.89, 0.0001)],
      0.95
    );
    expect(order(ranked)).toEqual(['meets', 'below-band']);
  });
  it('needs a large value gain before a lower-accuracy candidate wins', () => {
    const ranked = rankCandidates(
      [rankInput('accurate', 1, 0.002), rankInput('in-band-4x-cheaper', 0.9, 0.0005)],
      0.95
    );
    expect(order(ranked)).toEqual(['accurate', 'in-band-4x-cheaper']);
  });
  it('ranks a competing candidate without latency data after those with it', () => {
    const ranked = rankCandidates(
      [rankInput('no-latency', 1, 0.0001, null), rankInput('measured', 1, 0.01)],
      0.95
    );
    expect(order(ranked)).toEqual(['measured', 'no-latency']);
  });
  it('falls back to highest accuracy when nothing competes', () => {
    const ranked = rankCandidates([rankInput('a', 0.5, 1), rankInput('b', 0.6, 5)], 0.9);
    expect(ranked[0].model).toBe('b');
  });
});

describe('RoutingTableSchema', () => {
  it('preserves sparse complexity mappings and rejects unknown buckets and routes', () => {
    const table = {
      version: 'complexity-fixture',
      generatedAt: new Date(0).toISOString(),
      minAccuracy: 0.7,
      switchCostFactor: 3,
      source: 'benchmark',
      routes: { 'implementation/code_generation': [candidate('m', 1, 1)] },
    };
    const effortByComplexity = {
      'implementation/code_generation': { m: { low: null, high: 'high' } },
    };
    expect(RoutingTableSchema.parse({ ...table, effortByComplexity }).effortByComplexity).toEqual(
      effortByComplexity
    );
    expect(CustomRoutingTableSchema.parse({ ...table, effortByComplexity }).effortByComplexity).toEqual(
      effortByComplexity
    );
    expect(
      RoutingTableSchema.safeParse({
        ...table,
        effortByComplexity: { 'implementation/code_generation': { m: { impossible: 'high' } } },
      }).success
    ).toBe(false);
    expect(
      RoutingTableSchema.safeParse({
        ...table,
        effortByComplexity: { unknown: { m: { high: 'high' } } },
      }).success
    ).toBe(false);
  });
  it('requires at least one candidate per taxonomy route', () => {
    expect(
      RoutingTableSchema.safeParse({
        version: 'v',
        generatedAt: new Date(0).toISOString(),
        minAccuracy: 0.7,
        switchCostFactor: 3,
        source: 'benchmark',
        routes: {
          'implementation/code_generation': [],
          'debugging/bug_fixing': [candidate('m', 1, 1)],
        },
      }).success
    ).toBe(false);
  });

  it('accepts a table routed by classifier taxonomy pair', () => {
    const parsed = RoutingTableSchema.parse({
      version: 'v',
      generatedAt: new Date(0).toISOString(),
      minAccuracy: 0.7,
      switchCostFactor: 3,
      source: 'benchmark',
      routes: {
        'implementation/code_generation': [candidate('impl', 0.9, 1)],
        'debugging/bug_fixing': [candidate('debug', 0.9, 1)],
      },
    });

    expect(parsed.routes['implementation/code_generation']?.[0]?.model).toBe('impl');
    expect(parsed.lowConfidenceThreshold).toBeUndefined();
  });

  it('preserves optional confidence thresholds and validates their range', () => {
    const table = {
      version: 'synthetic-confidence',
      generatedAt: new Date(0).toISOString(),
      minAccuracy: 0.7,
      switchCostFactor: 3,
      source: 'benchmark',
      routes: { 'implementation/code_generation': [candidate('m', 1, 1)] },
    };
    for (const lowConfidenceThreshold of [null, 0, 0.8, 1]) {
      expect(
        RoutingTableSchema.parse({ ...table, lowConfidenceThreshold }).lowConfidenceThreshold
      ).toBe(lowConfidenceThreshold);
    }
    expect(RoutingTableSchema.safeParse({ ...table, lowConfidenceThreshold: -0.1 }).success).toBe(
      false
    );
    expect(RoutingTableSchema.safeParse({ ...table, lowConfidenceThreshold: 1.1 }).success).toBe(
      false
    );
  });

  it('accepts a legacy candidate with reasoningEffort only', () => {
    const parsed = RankedCandidateSchema.parse({
      model: 'm',
      accuracy: 0.9,
      avgCostUsd: 1,
      meetsThreshold: true,
      reasoningEffort: 'high',
    });
    expect(parsed.reasoningEffort).toBe('high');
    expect(parsed.variant).toBeUndefined();
    expect(parsed.cases).toBeUndefined();
  });

  it('accepts a candidate with variant only', () => {
    const parsed = RankedCandidateSchema.parse({
      model: 'm',
      accuracy: 0.9,
      avgCostUsd: 1,
      meetsThreshold: true,
      variant: 'xhigh',
    });
    expect(parsed.variant).toBe('xhigh');
    expect(parsed.reasoningEffort).toBeUndefined();
  });

  it('accepts measured case counts and rejects invalid counts', () => {
    expect(RankedCandidateSchema.parse({ ...candidate('m', 1, 1), cases: 30 }).cases).toBe(30);
    expect(RankedCandidateSchema.parse({ ...candidate('m', 1, 1), cases: null }).cases).toBeNull();
    expect(RankedCandidateSchema.safeParse({ ...candidate('m', 1, 1), cases: -1 }).success).toBe(
      false
    );
    expect(RankedCandidateSchema.safeParse({ ...candidate('m', 1, 1), cases: 1.5 }).success).toBe(
      false
    );
  });

  it('rejects a candidate with both non-null variant and reasoningEffort', () => {
    expect(
      RankedCandidateSchema.safeParse({
        model: 'm',
        accuracy: 0.9,
        avgCostUsd: 1,
        meetsThreshold: true,
        variant: 'xhigh',
        reasoningEffort: 'high',
      }).success
    ).toBe(false);
  });
});

describe('CustomRoutingTableSchema', () => {
  const base = {
    version: 'v',
    generatedAt: new Date(0).toISOString(),
    minAccuracy: 0.7,
    switchCostFactor: 3,
    source: 'benchmark' as const,
  };

  it('accepts a sparse routes record (omitted taxonomy keys)', () => {
    const parsed = CustomRoutingTableSchema.parse({
      ...base,
      routes: {
        'implementation/code_generation': [candidate('impl', 0.9, 1)],
      },
    });
    expect(Object.keys(parsed.routes)).toEqual(['implementation/code_generation']);
  });

  it('rejects unknown route keys', () => {
    expect(
      CustomRoutingTableSchema.safeParse({
        ...base,
        routes: {
          'not-a-real/route': [candidate('m', 1, 1)],
        },
      }).success
    ).toBe(false);
  });
});

describe('EfficientModelPoolSchema', () => {
  it('rejects duplicate exact pairs', () => {
    expect(
      EfficientModelPoolSchema.safeParse([
        { model: 'a/b', variant: 'xhigh' },
        { model: 'a/b', variant: 'xhigh' },
      ]).success
    ).toBe(false);
  });

  it('accepts the same model with different variants', () => {
    const parsed = EfficientModelPoolSchema.parse([
      { model: 'a/b', variant: 'xhigh' },
      { model: 'a/b', variant: 'max' },
    ]);
    expect(parsed).toHaveLength(2);
  });

  it('rejects zero entries', () => {
    expect(EfficientModelPoolSchema.safeParse([]).success).toBe(false);
  });

  it('rejects more than MAX_POOL_ENTRIES entries', () => {
    const entries = Array.from({ length: MAX_POOL_ENTRIES + 1 }, (_, i) => ({
      model: `model/${i}`,
      variant: null,
    }));
    expect(EfficientModelPoolSchema.safeParse(entries).success).toBe(false);
  });

  it('accepts null pool via nullable wrapper (inherit)', () => {
    expect(EfficientModelPoolSchema.nullable().safeParse(null).success).toBe(true);
  });

  it('accepts the maximum of 10 unique entries', () => {
    const entries = Array.from({ length: MAX_POOL_ENTRIES }, (_, i) => ({
      model: `model/${i}`,
      variant: null as string | null,
    }));
    expect(EfficientModelPoolSchema.safeParse(entries).success).toBe(true);
  });
});

describe('poolEntryKey', () => {
  it('distinguishes xhigh, max, and null variants of one model', () => {
    const model = 'provider/model';
    const keys = [
      poolEntryKey({ model, variant: 'xhigh' }),
      poolEntryKey({ model, variant: 'max' }),
      poolEntryKey({ model, variant: null }),
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it('round-trips through JSON as a collision-safe encoding', () => {
    const entry = { model: 'provider/model', variant: 'xhigh' as string | null };
    const key = poolEntryKey(entry);
    expect(JSON.parse(key)).toEqual([entry.model, entry.variant]);
    expect(poolEntryKey({ model: entry.model, variant: entry.variant })).toBe(key);
  });
});
