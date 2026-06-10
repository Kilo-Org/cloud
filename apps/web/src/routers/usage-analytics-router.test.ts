jest.mock('@/lib/redis', () => ({ redisClient: {} }));

import {
  CostSourceSchema,
  UsageAnalyticsFiltersSchema,
  costColumnFor,
  costSumExprSql,
} from './usage-analytics-router';

const baseFilters = {
  startDate: '2026-06-04T00:00:00.000Z',
  endDate: '2026-06-05T00:00:00.000Z',
  granularity: 'day' as const,
};

describe('usage analytics cost source', () => {
  it('defaults to billable cost for existing clients', () => {
    expect(UsageAnalyticsFiltersSchema.parse(baseFilters).costSource).toBe('cost');
    expect(costColumnFor('cost')).toBe('total_cost_microdollars');
    expect(costSumExprSql('cost')).toBe('COALESCE(SUM(total_cost_microdollars), 0)');
  });

  it('uses the estimated market cost rollup when selected', () => {
    expect(
      UsageAnalyticsFiltersSchema.parse({ ...baseFilters, costSource: 'market' }).costSource
    ).toBe('market');
    expect(costColumnFor('market')).toBe('total_market_cost_microdollars');
    expect(costSumExprSql('market')).toBe('COALESCE(SUM(total_market_cost_microdollars), 0)');
  });

  it('rejects arbitrary cost source values', () => {
    expect(
      CostSourceSchema.safeParse('total_cost_microdollars); DROP TABLE usage; --').success
    ).toBe(false);
  });
});
