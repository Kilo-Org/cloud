import { describe, expect, it } from 'vitest';
import {
  CustomRoutingTableSchema,
  EfficientModelPoolSchema,
  MAX_POOL_ENTRIES,
  poolEntryKey,
  rankCandidates,
  RankedCandidateSchema,
  RoutingTableSchema,
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

describe('rankCandidates', () => {
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
    expect(ranked[0]).not.toHaveProperty('p50LatencyMs');
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
