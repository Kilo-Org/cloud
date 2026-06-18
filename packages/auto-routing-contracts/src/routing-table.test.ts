import { describe, expect, it } from 'vitest';
import { rankCandidates, RoutingTableSchema } from './routing-table';

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
});
