import { describe, expect, it } from 'vitest';
import { rankCandidates, RoutingTableSchema } from './routing-table';

const candidate = (model: string, accuracy: number, avgCostUsd: number) => ({
  model,
  accuracy,
  avgCostUsd,
  meetsThreshold: false,
});

describe('rankCandidates', () => {
  it('puts the cheapest above-threshold candidate first', () => {
    const ranked = rankCandidates(
      [candidate('expensive', 0.95, 10), candidate('cheap', 0.8, 1), candidate('weak', 0.5, 0.1)],
      0.7
    );
    expect(ranked.map(c => c.model)).toEqual(['cheap', 'expensive', 'weak']);
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
  it('requires at least one candidate per tier', () => {
    expect(
      RoutingTableSchema.safeParse({
        version: 'v',
        generatedAt: new Date(0).toISOString(),
        minAccuracy: 0.7,
        source: 'benchmark',
        tiers: { low: [], medium: [candidate('m', 1, 1)], high: [candidate('h', 1, 1)] },
      }).success
    ).toBe(false);
  });
});
