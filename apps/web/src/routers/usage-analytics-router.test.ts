jest.mock('@/lib/redis', () => ({ redisClient: {} }));

import {
  CostSourceSchema,
  MAX_SCOPE_ORGANIZATION_IDS,
  UsageAnalyticsFiltersSchema,
  WhereBuilder,
  buildScopeConditions,
  costColumnFor,
  costSumExprSql,
} from './usage-analytics-router';

const baseFilters = {
  startDate: '2026-06-04T00:00:00.000Z',
  endDate: '2026-06-05T00:00:00.000Z',
  granularity: 'day' as const,
};

const CTX_USER = 'user-1';
const PARENT_ORG = '11111111-1111-4111-8111-111111111111';
const CHILD_ORG_A = '22222222-2222-4222-8222-222222222222';
const CHILD_ORG_B = '33333333-3333-4333-8333-333333333333';

function scopeSql(rawFilters: Record<string, unknown>) {
  const filters = UsageAnalyticsFiltersSchema.parse({ ...baseFilters, ...rawFilters });
  const where = new WhereBuilder();
  buildScopeConditions(where, filters, CTX_USER);
  return { sql: where.sql(), bindings: where.bindings.map(b => b.value) };
}

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

describe('usage analytics scope conditions', () => {
  it('pins a single org to the caller in self view', () => {
    const { sql, bindings } = scopeSql({ organizationId: PARENT_ORG, viewAs: 'self' });
    expect(sql).toContain('organization_id = ?');
    expect(sql).toContain('kilo_user_id = ?');
    expect(bindings).toEqual([PARENT_ORG, CTX_USER]);
  });

  it('does not pin to the caller in org-wide view', () => {
    const { sql, bindings } = scopeSql({ organizationId: PARENT_ORG, viewAs: 'org-wide' });
    expect(sql).toContain('organization_id = ?');
    expect(sql).not.toContain('kilo_user_id');
    expect(bindings).toEqual([PARENT_ORG]);
  });

  it('aggregates org-wide across all orgs when organizationIds is set', () => {
    const { sql, bindings } = scopeSql({
      organizationIds: [PARENT_ORG, CHILD_ORG_A, CHILD_ORG_B],
    });
    expect(sql).toContain('organization_id IN (?, ?, ?)');
    expect(sql).not.toContain('kilo_user_id');
    expect(bindings).toEqual([PARENT_ORG, CHILD_ORG_A, CHILD_ORG_B]);
  });

  it('honors explicit user filters in the all-orgs aggregate', () => {
    const { sql, bindings } = scopeSql({
      organizationIds: [PARENT_ORG, CHILD_ORG_A],
      userIds: [CTX_USER],
    });
    expect(sql).toContain('organization_id IN (?, ?)');
    expect(sql).toContain('kilo_user_id IN (?)');
    expect(bindings).toEqual([PARENT_ORG, CHILD_ORG_A, CTX_USER]);
  });

  it('takes precedence over a single organizationId', () => {
    const { sql, bindings } = scopeSql({
      organizationId: CHILD_ORG_B,
      organizationIds: [PARENT_ORG, CHILD_ORG_A],
    });
    expect(sql).toContain('organization_id IN (?, ?)');
    expect(bindings).toEqual([PARENT_ORG, CHILD_ORG_A]);
  });

  it('falls back to personal scope with no org', () => {
    const { sql, bindings } = scopeSql({});
    expect(sql).toContain('kilo_user_id = ?');
    expect(sql).toContain('organization_id = ?');
    // personal-only pins kilo_user_id to caller and org to the empty-string sentinel
    expect(bindings).toEqual([CTX_USER, '']);
  });

  it('caps organizationIds at the boundary to bound auth fan-out', () => {
    const makeIds = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(
      UsageAnalyticsFiltersSchema.safeParse({
        ...baseFilters,
        organizationIds: makeIds(MAX_SCOPE_ORGANIZATION_IDS),
      }).success
    ).toBe(true);
    expect(
      UsageAnalyticsFiltersSchema.safeParse({
        ...baseFilters,
        organizationIds: makeIds(MAX_SCOPE_ORGANIZATION_IDS + 1),
      }).success
    ).toBe(false);
  });
});
