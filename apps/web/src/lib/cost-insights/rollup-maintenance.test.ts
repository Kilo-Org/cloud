import type { CanonicalCostInsightOwnerTotal } from './canonical-sources';
import {
  assertCanonicalTotalsMatchDrivers,
  compareCostInsightHourAggregates,
} from './rollup-maintenance';

const hourStart = '2026-06-01T00:00:00.000Z';
const owner = { type: 'user', id: 'user-1' } as const;
const total: CanonicalCostInsightOwnerTotal = {
  owner,
  category: 'variable',
  totalMicrodollars: 10,
  spendRecordCount: 2,
};

function rollupValue(params: { amount: number; count: number }) {
  return {
    owner,
    category: 'variable' as const,
    totalMicrodollars: params.amount,
    spendRecordCount: params.count,
  };
}

describe('Cost Insights rollup maintenance', () => {
  test('accepts canonical totals that equal combined driver sums', () => {
    expect(() =>
      assertCanonicalTotalsMatchDrivers({
        totals: [total],
        drivers: [
          {
            owner,
            category: 'variable',
            source: 'other',
            productKey: 'exa',
            featureKey: 'search',
            modelOrPlanKey: 'other',
            providerKey: 'exa',
            actorUserId: 'user-1',
            totalMicrodollars: 4,
            spendRecordCount: 1,
            driverKey: 'a'.repeat(64),
          },
          {
            owner,
            category: 'variable',
            source: 'ai_gateway',
            productKey: 'direct-gateway',
            featureKey: 'responses',
            modelOrPlanKey: 'model',
            providerKey: 'provider',
            actorUserId: 'user-1',
            totalMicrodollars: 6,
            spendRecordCount: 1,
            driverKey: 'b'.repeat(64),
          },
        ],
      })
    ).not.toThrow();
  });

  test('rejects canonical totals that differ from driver sums', () => {
    expect(() =>
      assertCanonicalTotalsMatchDrivers({
        totals: [total],
        drivers: [
          {
            owner,
            category: 'variable',
            source: 'other',
            productKey: 'exa',
            featureKey: 'search',
            modelOrPlanKey: 'other',
            providerKey: 'exa',
            actorUserId: 'user-1',
            totalMicrodollars: 9,
            spendRecordCount: 2,
            driverKey: 'a'.repeat(64),
          },
        ],
      })
    ).toThrow('totals do not equal combined driver sums');
  });

  test('reports missing total, driver sum, and unknown taxonomy mismatch classes', () => {
    const mismatches = compareCostInsightHourAggregates({
      hourStart,
      canonicalTotals: [total],
      persistedTotals: new Map(),
      persistedDriverSums: new Map(),
      unknownTaxonomyValues: [
        {
          sourceFamily: 'exa',
          field: 'feature_key',
          value: '/new-operation',
          spendRecordCount: 1,
        },
      ],
    });

    expect(mismatches.map(mismatch => mismatch.type)).toEqual([
      'missing_total',
      'record_count_difference',
      'driver_sum_difference',
      'unknown_taxonomy_value',
    ]);
  });

  test('reports amount, record-count, and driver-sum differences independently', () => {
    const mismatches = compareCostInsightHourAggregates({
      hourStart,
      canonicalTotals: [total],
      persistedTotals: new Map([['user:user-1:variable', rollupValue({ amount: 8, count: 1 })]]),
      persistedDriverSums: new Map([
        ['user:user-1:variable', rollupValue({ amount: 7, count: 1 })],
      ]),
    });

    expect(mismatches).toEqual([
      expect.objectContaining({
        type: 'amount_difference',
        expectedMicrodollars: 10,
        actualMicrodollars: 8,
      }),
      expect.objectContaining({
        type: 'record_count_difference',
        expectedRecordCount: 2,
        actualRecordCount: 1,
      }),
      expect.objectContaining({
        type: 'driver_sum_difference',
        expectedMicrodollars: 10,
        actualMicrodollars: 7,
        expectedRecordCount: 2,
        actualRecordCount: 1,
      }),
    ]);
  });

  test('reports inflated orphan rollup rows against a zero canonical source sum', () => {
    const mismatches = compareCostInsightHourAggregates({
      hourStart,
      canonicalTotals: [],
      persistedTotals: new Map([['user:user-1:variable', rollupValue({ amount: 10, count: 2 })]]),
      persistedDriverSums: new Map([
        ['user:user-1:variable', rollupValue({ amount: 10, count: 2 })],
      ]),
    });

    expect(mismatches.map(mismatch => mismatch.type)).toEqual([
      'amount_difference',
      'record_count_difference',
      'driver_sum_difference',
    ]);
  });
});
