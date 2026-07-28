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

describe('rankCandidates', () => {
  it('puts the lowest cost-per-accuracy above-threshold candidate first', () => {
    const ranked = rankCandidates(
      [
        candidate('lower-raw-cost', 0.7, 0.007),
        candidate('better-value', 0.9, 0.008),
        candidate('weak', 0.5, 0.001),
      ],
      0.7
    );
    expect(ranked.map(c => c.model)).toEqual(['better-value', 'lower-raw-cost', 'weak']);
    expect(ranked[0].meetsThreshold).toBe(true);
    expect(ranked[2].meetsThreshold).toBe(false);
  });
  it('falls back to highest accuracy when nothing meets the threshold', () => {
    const ranked = rankCandidates([candidate('a', 0.5, 1), candidate('b', 0.6, 5)], 0.9);
    expect(ranked[0].model).toBe('b');
  });
  it('breaks cost ties by accuracy', () => {
    const ranked = rankCandidates([candidate('a', 0.8, 1), candidate('b', 0.9, 1)], 0.7);
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
