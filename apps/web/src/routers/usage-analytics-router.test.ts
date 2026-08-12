jest.mock('@/lib/redis', () => ({ redisClient: {} }));

import { PgDialect } from 'drizzle-orm/pg-core';
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

const dialect = new PgDialect();

function compile(builder: WhereBuilder) {
  const sql = builder.toSQL();
  if (!sql) return { sql: '', params: [] as unknown[] };
  const compiled = dialect.sqlToQuery(sql);
  return { sql: compiled.sql, params: compiled.params };
}

function scopeSql(rawFilters: Record<string, unknown>) {
  const filters = UsageAnalyticsFiltersSchema.parse({ ...baseFilters, ...rawFilters });
  const where = new WhereBuilder();
  buildScopeConditions(where, filters, CTX_USER);
  return compile(where);
}

describe('usage analytics cost source', () => {
  it('defaults to billable cost for existing clients', () => {
    expect(UsageAnalyticsFiltersSchema.parse(baseFilters).costSource).toBe('cost');
    expect(dialect.sqlToQuery(costColumnFor('cost')).sql).toContain('cost');
    expect(dialect.sqlToQuery(costSumExprSql('cost')).sql).toMatch(/COALESCE\(SUM\(/);
    expect(dialect.sqlToQuery(costSumExprSql('cost')).sql).toContain('cost');
    expect(dialect.sqlToQuery(costSumExprSql('cost')).sql).not.toContain('market_cost');
  });

  it('uses the estimated market cost when selected', () => {
    expect(
      UsageAnalyticsFiltersSchema.parse({ ...baseFilters, costSource: 'market' }).costSource
    ).toBe('market');
    expect(dialect.sqlToQuery(costColumnFor('market')).sql).toContain('market_cost');
    expect(dialect.sqlToQuery(costSumExprSql('market')).sql).toMatch(/COALESCE\(SUM\(/);
    expect(dialect.sqlToQuery(costSumExprSql('market')).sql).toContain('market_cost');
  });

  it('rejects arbitrary cost source values', () => {
    expect(
      CostSourceSchema.safeParse('total_cost_microdollars); DROP TABLE usage; --').success
    ).toBe(false);
  });
});

describe('usage analytics scope conditions', () => {
  it('pins a single org to the caller in self view', () => {
    const { sql, params } = scopeSql({ organizationId: PARENT_ORG, viewAs: 'self' });
    expect(sql).toContain('organization_id');
    expect(sql).toContain('kilo_user_id');
    expect(sql).not.toMatch(/is null/i);
    expect(params).toEqual([PARENT_ORG, CTX_USER]);
  });

  it('does not pin to the caller in org-wide view', () => {
    const { sql, params } = scopeSql({ organizationId: PARENT_ORG, viewAs: 'org-wide' });
    expect(sql).toContain('organization_id');
    expect(sql).not.toContain('kilo_user_id');
    expect(params).toEqual([PARENT_ORG]);
  });

  it('aggregates org-wide across all orgs when organizationIds is set', () => {
    const { sql, params } = scopeSql({
      organizationIds: [PARENT_ORG, CHILD_ORG_A, CHILD_ORG_B],
    });
    expect(sql).toContain('organization_id');
    expect(sql).toMatch(/in/i);
    expect(sql).not.toContain('kilo_user_id');
    expect(params).toEqual([PARENT_ORG, CHILD_ORG_A, CHILD_ORG_B]);
  });

  it('honors explicit user filters in the all-orgs aggregate', () => {
    const { sql, params } = scopeSql({
      organizationIds: [PARENT_ORG, CHILD_ORG_A],
      userIds: [CTX_USER],
    });
    expect(sql).toContain('organization_id');
    expect(sql).toContain('kilo_user_id');
    expect(params).toEqual([PARENT_ORG, CHILD_ORG_A, CTX_USER]);
  });

  it('takes precedence over a single organizationId', () => {
    const { sql, params } = scopeSql({
      organizationId: CHILD_ORG_B,
      organizationIds: [PARENT_ORG, CHILD_ORG_A],
    });
    expect(sql).toContain('organization_id');
    expect(params).toEqual([PARENT_ORG, CHILD_ORG_A]);
  });

  it('falls back to personal scope with no org', () => {
    const { sql, params } = scopeSql({});
    expect(sql).toContain('kilo_user_id');
    expect(sql).toContain('organization_id');
    // personal-only pins kilo_user_id to caller and organization_id IS NULL
    expect(sql).toMatch(/is null/i);
    expect(params).toEqual([CTX_USER]);
  });

  it('includes org-attributed rows when personalScope is include-orgs', () => {
    const { sql, params } = scopeSql({ personalScope: 'include-orgs' });
    expect(sql).toContain('kilo_user_id');
    expect(sql).not.toContain('organization_id');
    expect(params).toEqual([CTX_USER]);
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
