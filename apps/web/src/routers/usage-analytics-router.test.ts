jest.mock('@/lib/redis', () => ({ redisClient: {} }));
jest.mock('@/lib/snowflake', () => ({
  resolveSnowflakeConfig: jest.fn(),
  executeSnowflakeStatement: jest.fn(),
}));

import {
  executeSnowflakeStatement,
  resolveSnowflakeConfig,
  type SnowflakeConfig,
} from '@/lib/snowflake';
import { defineTestUser } from '@/tests/helpers/user.helper';

const mockResolveSnowflakeConfig = jest.mocked(resolveSnowflakeConfig);
const mockExecuteSnowflakeStatement = jest.mocked(executeSnowflakeStatement);

import {
  BreakdownInputSchema,
  CostSourceSchema,
  MAX_SCOPE_ORGANIZATION_IDS,
  TableInputSchema,
  TimeseriesInputSchema,
  UsageAnalyticsFiltersSchema,
  WhereBuilder,
  buildScopeConditions,
  costColumnFor,
  costSumExprSql,
  dimensionColumn,
  usageAnalyticsRouter,
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
const SNOWFLAKE_CONFIG = {
  accountHost: 'account.snowflakecomputing.com',
  jwtAccountIdentifier: 'ACCOUNT',
  username: 'user',
  role: 'role',
  warehouse: 'warehouse',
  database: 'database',
  schema: 'schema',
  privateKeyPem: 'key',
  publicKeyFingerprint: 'SHA256:fingerprint',
} satisfies SnowflakeConfig;

function caller() {
  return usageAnalyticsRouter.createCaller({ user: defineTestUser({ id: CTX_USER }) });
}

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

describe('usage analytics organization breakdown', () => {
  const breakdownInput = {
    ...baseFilters,
    dimension: 'organization',
    metric: 'cost',
  };

  it('allows organization only as a breakdown dimension', () => {
    expect(BreakdownInputSchema.safeParse(breakdownInput).success).toBe(true);
    expect(
      TimeseriesInputSchema.safeParse({
        ...baseFilters,
        metric: 'cost',
        splitBy: 'organization',
      }).success
    ).toBe(false);
    expect(
      TableInputSchema.safeParse({
        ...baseFilters,
        groupBy: ['organization'],
      }).success
    ).toBe(false);
  });

  it('allows organization breakdown limits up to the organization scope cap', () => {
    expect(
      BreakdownInputSchema.safeParse({
        ...breakdownInput,
        limit: MAX_SCOPE_ORGANIZATION_IDS,
      }).success
    ).toBe(true);
    expect(
      BreakdownInputSchema.safeParse({
        ...breakdownInput,
        limit: MAX_SCOPE_ORGANIZATION_IDS + 1,
      }).success
    ).toBe(false);
  });

  it('keeps other breakdown dimensions capped at 100', () => {
    expect(
      BreakdownInputSchema.safeParse({ ...breakdownInput, dimension: 'model', limit: 100 }).success
    ).toBe(true);
    expect(
      BreakdownInputSchema.safeParse({ ...breakdownInput, dimension: 'model', limit: 101 }).success
    ).toBe(false);
  });

  it('maps the organization dimension to the Snowflake organization column', () => {
    expect(dimensionColumn('organization')).toBe('organization_id');
  });
});

describe('usage analytics procedures', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveSnowflakeConfig.mockReturnValue(SNOWFLAKE_CONFIG);
    mockExecuteSnowflakeStatement.mockResolvedValue([]);
  });

  it('keeps include-orgs personal usage scoped to the caller without the personal sentinel', async () => {
    mockExecuteSnowflakeStatement.mockResolvedValue([
      ['100', '2', '3', '4', '5', '6', '0', '0', '0', '7', '8', '9', '2', '1', '7', '1'],
    ]);

    await expect(
      caller().getSummary({ ...baseFilters, personalScope: 'include-orgs', features: ['chat'] })
    ).resolves.toMatchObject({
      costMicrodollars: 100,
      byokRequestCount: 7,
      effectiveGranularity: 'day',
    });

    const request = mockExecuteSnowflakeStatement.mock.calls[0][0];
    expect(request.statement).toContain('COALESCE(SUM(user_byok_request_count), 0)');
    expect(request.statement).toContain('MICRODOLLAR_USAGE_DAILY');
    expect(request.bindings).toEqual([
      { type: 'TEXT', value: '2026-06-04' },
      { type: 'TEXT', value: '2026-06-05' },
      { type: 'TEXT', value: CTX_USER },
      { type: 'TEXT', value: 'chat' },
    ]);
  });

  it('uses the user BYOK rollup in the hourly summary tier', async () => {
    const endDate = new Date().toISOString();
    const startDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    await caller().getSummary({ ...baseFilters, startDate, endDate, granularity: 'hour' });

    expect(mockExecuteSnowflakeStatement.mock.calls[0][0].statement).toContain(
      'COALESCE(SUM(user_byok_request_count), 0)'
    );
    expect(mockExecuteSnowflakeStatement.mock.calls[0][0].statement).toContain(
      'MICRODOLLAR_USAGE_HOURLY'
    );
  });

  it('maps timeseries, breakdown, and table Snowflake rows', async () => {
    mockExecuteSnowflakeStatement
      .mockResolvedValueOnce([['2026-06-04', '12', 'model-a']])
      .mockResolvedValueOnce([
        ['model-a', '3'],
        ['model-b', '1'],
      ])
      .mockResolvedValueOnce([
        ['2026-06-04', 'chat', '', '', '', '', '', '10', '2', '3', '4', '5', '6', '7'],
      ]);

    await expect(
      caller().getTimeseries({ ...baseFilters, metric: 'requests', splitBy: 'model' })
    ).resolves.toEqual({
      timeseries: [{ datetime: '2026-06-04', value: 12, label: 'model-a' }],
      effectiveGranularity: 'day',
    });
    await expect(
      caller().getBreakdown({ ...baseFilters, dimension: 'model', metric: 'requests' })
    ).resolves.toEqual({
      breakdown: [
        { key: 'model-a', label: 'model-a', value: 3, percentage: 75 },
        { key: 'model-b', label: 'model-b', value: 1, percentage: 25 },
      ],
      totalValue: 4,
      effectiveGranularity: 'day',
    });
    await expect(caller().getTable({ ...baseFilters, groupBy: ['feature'] })).resolves.toEqual({
      rows: [
        {
          datetime: '2026-06-04',
          dimensions: { feature: 'chat' },
          costMicrodollars: 10,
          requestCount: 2,
          inputTokens: 3,
          outputTokens: 4,
          cacheWriteTokens: 5,
          cacheHitTokens: 6,
          errorCount: 7,
        },
      ],
      effectiveGranularity: 'day',
    });

    expect(mockExecuteSnowflakeStatement.mock.calls[0][0].statement).toContain('GROUP BY 1, 3');
    expect(mockExecuteSnowflakeStatement.mock.calls[1][0].statement).toContain('GROUP BY 1');
    expect(mockExecuteSnowflakeStatement.mock.calls[2][0].statement).toContain('dim_feature');
  });

  it('allows successful empty results for every Snowflake procedure', async () => {
    await expect(caller().getSummary(baseFilters)).resolves.toMatchObject({ requestCount: 0 });
    await expect(caller().getTimeseries({ ...baseFilters, metric: 'cost' })).resolves.toMatchObject(
      {
        timeseries: [],
      }
    );
    await expect(
      caller().getBreakdown({ ...baseFilters, dimension: 'model', metric: 'cost' })
    ).resolves.toMatchObject({ breakdown: [], totalValue: 0 });
    await expect(caller().getTable({ ...baseFilters, groupBy: [] })).resolves.toMatchObject({
      rows: [],
    });
  });

  it.each([
    () => caller().getSummary(baseFilters),
    () => caller().getTimeseries({ ...baseFilters, metric: 'cost' }),
    () => caller().getBreakdown({ ...baseFilters, dimension: 'model', metric: 'cost' }),
    () => caller().getTable({ ...baseFilters, groupBy: [] }),
  ])('rejects missing Snowflake configuration with a sanitized error', async invoke => {
    mockResolveSnowflakeConfig.mockReturnValue(null);

    await expect(invoke()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Usage data temporarily unavailable',
    });
    expect(mockExecuteSnowflakeStatement).not.toHaveBeenCalled();
  });

  it.each([
    () => caller().getSummary(baseFilters),
    () => caller().getTimeseries({ ...baseFilters, metric: 'cost' }),
    () => caller().getBreakdown({ ...baseFilters, dimension: 'model', metric: 'cost' }),
    () => caller().getTable({ ...baseFilters, groupBy: [] }),
  ])('sanitizes Snowflake query failures in responses and logs', async invoke => {
    mockExecuteSnowflakeStatement.mockRejectedValue(new Error('upstream response body'));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(invoke()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Usage data temporarily unavailable',
      });
      expect(mockExecuteSnowflakeStatement).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('"reason":"query_failed"'));
      expect(errorLog).not.toHaveBeenCalledWith(expect.stringContaining('upstream response body'));
    } finally {
      errorLog.mockRestore();
    }
  });

  it.each([
    () => caller().getSummary({ ...baseFilters, userIds: ['other-user'] }),
    () => caller().getTimeseries({ ...baseFilters, metric: 'cost', userIds: ['other-user'] }),
    () =>
      caller().getBreakdown({
        ...baseFilters,
        dimension: 'model',
        metric: 'cost',
        userIds: ['other-user'],
      }),
    () => caller().getTable({ ...baseFilters, groupBy: [], userIds: ['other-user'] }),
  ])('rejects another personal user before querying Snowflake', async invoke => {
    await expect(invoke()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockExecuteSnowflakeStatement).not.toHaveBeenCalled();
  });
});
