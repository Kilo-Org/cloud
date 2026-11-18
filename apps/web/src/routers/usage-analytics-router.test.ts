import { TRPCError } from '@trpc/server';
import {
  ensureOrganizationAccess,
  ensureOrganizationsAccess,
} from '@kilocode/web-shared/routers/organizations/utils';
jest.mock('@kilocode/web-shared/lib/trpc/init', () => {
  const { initTRPC } = jest.requireActual('@trpc/server');
  const t = initTRPC.create();
  return { baseProcedure: t.procedure, createTRPCRouter: t.router };
});
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ readDb: {}, db: {} }));
jest.mock('@kilocode/web-shared/lib/dotenvx', () => ({ getEnvVariable: jest.fn() }));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
  ensureOrganizationsAccess: jest.fn(),
  getOrganizationsAccessRoles: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/redis', () => ({ redisClient: {} }));
jest.mock('@/lib/snowflake', () => ({
  resolveSnowflakeConfig: jest.fn(),
  executeSnowflakeStatement: jest.fn(),
}));

import {
  executeSnowflakeStatement,
  resolveSnowflakeConfig,
  type SnowflakeConfig,
} from '@/lib/snowflake';
import { USAGE_SOURCE_NOT_CONFIGURED_MESSAGE } from '@kilocode/app-shared/usage-source';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

const mockResolveSnowflakeConfig = jest.mocked(resolveSnowflakeConfig);
const mockExecuteSnowflakeStatement = jest.mocked(executeSnowflakeStatement);

import {
  BreakdownInputSchema,
  CostSourceSchema,
  MAX_FILTER_VALUES,
  MAX_FILTER_VALUE_LENGTH,
  MAX_SCOPE_ORGANIZATION_IDS,
  TableInputSchema,
  TimeseriesInputSchema,
  UsageAnalyticsFiltersSchema,
  WhereBuilder,
  buildScopeConditions,
  costColumnFor,
  costSumExprSql,
  dimensionColumn,
  resolveTier,
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

describe('usage analytics filter bounds', () => {
  const FILTER_KEYS = [
    'features',
    'models',
    'modes',
    'userIds',
    'providers',
    'inferenceProviders',
    'projects',
    'excludedFeatures',
    'excludedModels',
    'excludedModes',
    'excludedUserIds',
    'excludedProviders',
    'excludedInferenceProviders',
    'excludedProjects',
  ] as const;

  const makeValues = (n: number) => Array.from({ length: n }, (_, i) => `value-${i}`);

  it.each(FILTER_KEYS)('caps %s element count at the boundary', key => {
    expect(
      UsageAnalyticsFiltersSchema.safeParse({
        ...baseFilters,
        [key]: makeValues(MAX_FILTER_VALUES),
      }).success
    ).toBe(true);

    const rejected = UsageAnalyticsFiltersSchema.safeParse({
      ...baseFilters,
      [key]: makeValues(MAX_FILTER_VALUES + 1),
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues).toEqual([
      expect.objectContaining({ code: 'too_big', path: [key] }),
    ]);
  });

  it.each(FILTER_KEYS)('caps %s value length at the boundary', key => {
    expect(
      UsageAnalyticsFiltersSchema.safeParse({
        ...baseFilters,
        [key]: ['x'.repeat(MAX_FILTER_VALUE_LENGTH)],
      }).success
    ).toBe(true);

    const rejected = UsageAnalyticsFiltersSchema.safeParse({
      ...baseFilters,
      [key]: ['x'.repeat(MAX_FILTER_VALUE_LENGTH + 1)],
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues).toEqual([
      expect.objectContaining({ code: 'too_big', path: [key, 0] }),
    ]);
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

describe('usage analytics inference provider dimension', () => {
  it('keeps provider mapped to the adapter column', () => {
    expect(dimensionColumn('provider')).toBe('provider');
  });

  it('maps inferenceProvider to the underlying inference_provider column', () => {
    expect(dimensionColumn('inferenceProvider')).toBe('inference_provider');
  });

  it('accepts inferenceProvider as a timeseries split and table group', () => {
    expect(
      TimeseriesInputSchema.safeParse({
        ...baseFilters,
        metric: 'cost',
        splitBy: 'inferenceProvider',
      }).success
    ).toBe(true);
    expect(
      TableInputSchema.safeParse({ ...baseFilters, groupBy: ['inferenceProvider'] }).success
    ).toBe(true);
  });

  it('caps groupBy at three dimensions even with inferenceProvider', () => {
    expect(
      TableInputSchema.safeParse({
        ...baseFilters,
        groupBy: ['provider', 'inferenceProvider', 'project', 'feature'],
      }).success
    ).toBe(false);
  });
});

describe('usage analytics date window', () => {
  const dateWindowFilters = {
    startDate: '2026-06-04T00:00:00.000Z',
    endDate: '2026-06-05T00:00:00.000Z',
    granularity: 'day' as const,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveSnowflakeConfig.mockReturnValue(SNOWFLAKE_CONFIG);
    mockExecuteSnowflakeStatement.mockResolvedValue([]);
  });

  it('requires an ordered date window on every procedure', async () => {
    const unordered = {
      ...dateWindowFilters,
      startDate: dateWindowFilters.endDate,
      endDate: dateWindowFilters.startDate,
    };

    await expect(caller().getSummary(unordered)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller().getTimeseries({ ...unordered, metric: 'cost' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().getBreakdown({ ...unordered, dimension: 'model', metric: 'cost' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().getTable({ ...unordered, groupBy: [] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    expect(mockExecuteSnowflakeStatement).not.toHaveBeenCalled();
  });

  it('accepts equal start and end timestamps', async () => {
    const instant = {
      ...dateWindowFilters,
      startDate: '2026-06-04T12:00:00.000Z',
      endDate: '2026-06-04T12:00:00.000Z',
    };

    expect(UsageAnalyticsFiltersSchema.safeParse(instant).success).toBe(true);
    await expect(caller().getSummary(instant)).resolves.toMatchObject({ requestCount: 0 });

    // The daily tier rounds the pair out to the UTC day that contains it.
    const bindings = mockExecuteSnowflakeStatement.mock.calls[0][0].bindings ?? [];
    const values = bindings.map(binding => binding.value);
    expect(values).toEqual(expect.arrayContaining(['2026-06-04', '2026-06-05']));
  });

  it('derives the aggregation tier from the window boundaries', () => {
    const older = '2024-01-01T00:00:00.000Z';
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Pairs an old boundary with a fresh one so the assertion keeps failing if
    // the clamp ever reads only one side of the window, whatever today's date.
    expect(resolveTier('hour', older, recent)).toEqual(resolveTier('hour', recent, older));
    expect(resolveTier('hour', older, recent).effectiveGranularity).toBe('day');
    expect(resolveTier('hour', recent, older).effectiveGranularity).toBe('day');

    const current = new Date().toISOString();
    expect(resolveTier('hour', recent, current)).toEqual(resolveTier('hour', current, recent));
    expect(resolveTier('hour', recent, current).effectiveGranularity).toBe('hour');
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

  it('keeps the default table SELECT free of the inference provider column', async () => {
    await caller().getTable({ ...baseFilters, groupBy: ['provider'] });

    const statement = mockExecuteSnowflakeStatement.mock.calls[0][0].statement;
    expect(statement).toContain('dim_provider');
    expect(statement).not.toContain('dim_inference_provider');
    expect(statement).toContain('COALESCE(SUM(error_count), 0)');
  });

  it('appends the inference provider column and groups by it when requested', async () => {
    mockExecuteSnowflakeStatement.mockResolvedValueOnce([
      ['2026-06-04', '', '', '', '', 'vercel', '', '10', '2', '3', '4', '5', '6', '7', 'bedrock'],
    ]);

    await expect(
      caller().getTable({ ...baseFilters, groupBy: ['provider', 'inferenceProvider'] })
    ).resolves.toEqual({
      rows: [
        {
          datetime: '2026-06-04',
          dimensions: { provider: 'vercel', inferenceProvider: 'bedrock' },
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

    const request = mockExecuteSnowflakeStatement.mock.calls[0][0];
    expect(request.statement).toContain('inference_provider AS dim_inference_provider');
    expect(request.statement).toContain('provider AS dim_provider');
    expect(request.statement).toContain('GROUP BY 1, provider, inference_provider');
  });

  it('composes autoModel and inferenceProvider trailing offsets without collision', async () => {
    mockExecuteSnowflakeStatement.mockResolvedValueOnce([
      [
        '2026-06-04',
        '',
        '',
        '',
        '',
        '',
        '',
        '10',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        'balanced',
        'bedrock',
      ],
    ]);

    await expect(
      caller().getTable({ ...baseFilters, groupBy: ['autoModel', 'inferenceProvider'] })
    ).resolves.toEqual({
      rows: [
        {
          datetime: '2026-06-04',
          dimensions: { autoModel: 'balanced', inferenceProvider: 'bedrock' },
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

    const request = mockExecuteSnowflakeStatement.mock.calls[0][0];
    expect(request.statement).toContain('auto_model AS dim_auto_model');
    expect(request.statement).toContain('inference_provider AS dim_inference_provider');
    expect(request.statement).toContain('GROUP BY 1, auto_model, inference_provider');
  });

  it('binds inference provider filters to the inference_provider column while provider stays adapter', async () => {
    mockExecuteSnowflakeStatement.mockResolvedValueOnce([
      ['2026-06-04', '', '', '', '', 'vercel', '', '10', '2', '3', '4', '5', '6', '7'],
    ]);

    await caller().getTable({
      ...baseFilters,
      groupBy: ['provider'],
      providers: ['vercel'],
      inferenceProviders: ['bedrock'],
    });

    const request = mockExecuteSnowflakeStatement.mock.calls[0][0];
    const values = (request.bindings ?? []).map(binding => binding.value);
    expect(values).toEqual(expect.arrayContaining(['bedrock', 'vercel']));
    expect(request.statement).toContain('\n  AND provider IN (?)');
    expect(request.statement).toContain('\n  AND inference_provider IN (?)');
  });

  it('retains NULL inference_provider rows when excluding named serving providers', async () => {
    mockExecuteSnowflakeStatement.mockResolvedValueOnce([]);

    await caller().getTable({
      ...baseFilters,
      groupBy: [],
      excludedInferenceProviders: ['bedrock'],
    });

    const request = mockExecuteSnowflakeStatement.mock.calls[0][0];
    expect(request.statement).toContain(
      '(inference_provider NOT IN (?) OR inference_provider IS NULL)'
    );
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
  ])('rejects missing usage-source configuration with the terminal message', async invoke => {
    mockResolveSnowflakeConfig.mockReturnValue(null);

    // "Not configured" is permanent and must be distinguishable on the wire
    // from a configured warehouse that failed, which is retryable.
    await expect(invoke()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: USAGE_SOURCE_NOT_CONFIGURED_MESSAGE,
    });
    expect(mockExecuteSnowflakeStatement).not.toHaveBeenCalled();
  });

  it.each([
    () => caller().getSummary(baseFilters),
    () => caller().getTimeseries({ ...baseFilters, metric: 'cost' }),
    () => caller().getBreakdown({ ...baseFilters, dimension: 'model', metric: 'cost' }),
    () => caller().getTable({ ...baseFilters, groupBy: [] }),
  ])('rejects a configured but failing warehouse with the retryable message', async invoke => {
    mockResolveSnowflakeConfig.mockReturnValue(SNOWFLAKE_CONFIG);
    mockExecuteSnowflakeStatement.mockRejectedValue(new Error('upstream response body'));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(invoke()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Usage data temporarily unavailable',
      });
      expect(mockResolveSnowflakeConfig).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
      mockExecuteSnowflakeStatement.mockReset();
    }
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
    () =>
      caller().getSummary({
        ...baseFilters,
        features: Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => `feature-${i}`),
      }),
    () =>
      caller().getTable({
        ...baseFilters,
        groupBy: [],
        excludedProjects: ['y'.repeat(MAX_FILTER_VALUE_LENGTH + 1)],
      }),
  ])('rejects out-of-bounds filters with a bad request', async invoke => {
    await expect(invoke()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockExecuteSnowflakeStatement).not.toHaveBeenCalled();
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

// These seams exercise the router and SQL generation without a database or warehouse.
describe('autoModel analytics', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockResolveSnowflakeConfig.mockReturnValue(SNOWFLAKE_CONFIG);
    mockExecuteSnowflakeStatement.mockResolvedValue([]);
  });

  const invokeAll = async (
    filters: Omit<typeof baseFilters, 'granularity'> & { granularity: 'hour' | 'day' } & Record<
        string,
        unknown
      >
  ) => {
    await caller().getSummary(filters);
    await caller().getTimeseries({ ...filters, metric: 'cost' });
    await caller().getBreakdown({ ...filters, dimension: 'model', metric: 'cost' });
    await caller().getTable({ ...filters, groupBy: [] });
  };

  it.each(['hour', 'day'] as const)(
    'binds alias and model filters on all %s endpoints',
    async granularity => {
      const startDate = new Date(Date.now() - 3600_000).toISOString();
      const endDate = new Date().toISOString();
      const alias = "custom'); DROP TABLE usage; --";
      await invokeAll({
        ...baseFilters,
        startDate,
        endDate,
        granularity,
        autoModels: [alias, 'Balanced'],
        excludedAutoModels: ['unknown'],
        models: ['classifier/model'],
        excludedModels: ['inference/model'],
        costSource: 'market',
      });
      expect(mockExecuteSnowflakeStatement).toHaveBeenCalledTimes(4);
      for (const [request] of mockExecuteSnowflakeStatement.mock.calls) {
        expect(request.statement).toContain(
          granularity === 'hour' ? 'MICRODOLLAR_USAGE_HOURLY' : 'MICRODOLLAR_USAGE_DAILY'
        );
        expect(request.statement).toContain('auto_model IN (?, ?)');
        expect(request.statement).toContain('auto_model NOT IN (?)');
        expect(request.statement).toContain('model IN (?)');
        expect(request.statement).toContain('model NOT IN (?)');
        expect(request.statement).toContain('kilo_user_id = ?');
        expect(request.statement).toContain('organization_id = ?');
        expect(request.statement).toContain('total_market_cost_microdollars');
        expect(request.statement).not.toContain(alias);
        expect(request.bindings?.map(b => b.value).slice(2)).toEqual([
          CTX_USER,
          '',
          'classifier/model',
          alias,
          'Balanced',
          'inference/model',
          'unknown',
        ]);
        expect(request.statement).toContain(
          granularity === 'hour'
            ? 'usage_hour >= ? AND usage_hour < ?'
            : 'usage_date >= ? AND usage_date < ?'
        );
      }
    }
  );

  it.each(['hour', 'day'] as const)(
    'retains untagged aliases without widening any scope in all %s endpoints',
    async granularity => {
      const startDate = new Date(Date.now() - 3600_000).toISOString();
      const endDate = new Date().toISOString();
      const excludedAlias = "custom') OR 1=1 --";
      const scopes = [
        { filters: {}, values: [CTX_USER, ''] },
        { filters: { personalScope: 'include-orgs' as const }, values: [CTX_USER] },
        {
          filters: { organizationId: PARENT_ORG, viewAs: 'self' as const },
          values: [PARENT_ORG, CTX_USER],
        },
        {
          filters: {
            organizationId: PARENT_ORG,
            viewAs: 'org-wide' as const,
            userIds: ['org-user'],
          },
          values: [PARENT_ORG, 'org-user'],
        },
        {
          filters: { organizationIds: [PARENT_ORG, CHILD_ORG_A], userIds: ['org-user'] },
          values: [PARENT_ORG, CHILD_ORG_A, 'org-user'],
        },
      ];
      for (const scope of scopes) {
        for (const autoModels of [undefined, ['Balanced']]) {
          mockExecuteSnowflakeStatement.mockClear();
          await invokeAll({
            ...baseFilters,
            startDate,
            endDate,
            granularity,
            ...scope.filters,
            autoModels,
            excludedAutoModels: ['Efficient', excludedAlias],
            excludedModels: ['classifier/model'],
            excludedProviders: ['vercel'],
          });
          expect(mockExecuteSnowflakeStatement).toHaveBeenCalledTimes(4);
          for (const [request] of mockExecuteSnowflakeStatement.mock.calls) {
            const timeColumn = granularity === 'hour' ? 'usage_hour' : 'usage_date';
            const dateValues =
              granularity === 'hour'
                ? [startDate, endDate]
                : [
                    startDate.slice(0, 10),
                    new Date(new Date(endDate).setUTCHours(24, 0, 0, 0)).toISOString().slice(0, 10),
                  ];
            expect(request.statement).toContain(`${timeColumn} >= ? AND ${timeColumn} < ?`);
            expect(request.statement).toContain(
              'userIds' in scope.filters ? 'kilo_user_id IN (?)' : 'kilo_user_id = ?'
            );
            if ('organizationIds' in scope.filters)
              expect(request.statement).toContain('organization_id IN (?, ?)');
            else if ('organizationId' in scope.filters || !('personalScope' in scope.filters))
              expect(request.statement).toContain('organization_id = ?');
            expect(request.statement).toContain(
              '\n  AND (auto_model NOT IN (?, ?) OR auto_model IS NULL)'
            );
            expect(request.statement.match(/\bOR\b/g)).toHaveLength(1);
            expect(request.statement).toContain('\n  AND model NOT IN (?)');
            expect(request.statement).toContain('\n  AND provider NOT IN (?)');
            expect(request.statement).not.toContain(excludedAlias);
            expect(request.statement.includes('auto_model IN (?)')).toBe(Boolean(autoModels));
            expect(request.bindings?.map(b => b.value)).toEqual([
              ...dateValues,
              ...scope.values,
              ...(autoModels ?? []),
              'classifier/model',
              'Efficient',
              excludedAlias,
              'vercel',
            ]);
          }
        }
      }
    }
  );

  it.each(['hour', 'day'] as const)(
    'maps %s alias labels and table metric positions without normalization',
    async granularity => {
      const filters = {
        ...baseFilters,
        granularity,
        startDate: new Date(Date.now() - 3600_000).toISOString(),
        endDate: new Date().toISOString(),
      };
      // SQL NULL fixtures exercise runtime behavior beyond the client's string-only cell type.
      mockExecuteSnowflakeStatement
        .mockResolvedValueOnce([
          ['bucket', '12', 'BaLaNcEd'],
          ['bucket', '3', null],
        ] as string[][])
        .mockResolvedValueOnce([
          ['unknown', '3'],
          [null, '1'],
        ] as string[][])
        .mockResolvedValueOnce([
          [
            'bucket',
            '',
            'classifier/model',
            '',
            '',
            '',
            '',
            '10',
            '2',
            '3',
            '4',
            '5',
            '6',
            '7',
            'BaLaNcEd',
          ],
          ['bucket', '', '', '', '', '', '', '20', '12', '13', '14', '15', '16', '17', null],
        ] as string[][]);
      expect(
        (await caller().getTimeseries({ ...filters, metric: 'requests', splitBy: 'autoModel' }))
          .timeseries
      ).toEqual([
        { datetime: 'bucket', value: 12, label: 'BaLaNcEd' },
        { datetime: 'bucket', value: 3, label: undefined },
      ]);
      expect(
        (await caller().getBreakdown({ ...filters, dimension: 'autoModel', metric: 'requests' }))
          .breakdown
      ).toEqual([
        { key: 'unknown', label: 'unknown', value: 3, percentage: 75 },
        { key: '', label: '', value: 1, percentage: 25 },
      ]);
      expect(
        (await caller().getTable({ ...filters, groupBy: ['model', 'autoModel'] })).rows
      ).toEqual([
        {
          datetime: 'bucket',
          dimensions: { model: 'classifier/model', autoModel: 'BaLaNcEd' },
          costMicrodollars: 10,
          requestCount: 2,
          inputTokens: 3,
          outputTokens: 4,
          cacheWriteTokens: 5,
          cacheHitTokens: 6,
          errorCount: 7,
        },
        {
          datetime: 'bucket',
          dimensions: { model: '', autoModel: '' },
          costMicrodollars: 20,
          requestCount: 12,
          inputTokens: 13,
          outputTokens: 14,
          cacheWriteTokens: 15,
          cacheHitTokens: 16,
          errorCount: 17,
        },
      ]);
      expect(mockExecuteSnowflakeStatement.mock.calls[0][0].statement).toContain(
        'auto_model AS label'
      );
      expect(mockExecuteSnowflakeStatement.mock.calls[1][0].statement).toContain(
        'auto_model AS key'
      );
      expect(mockExecuteSnowflakeStatement.mock.calls[2][0].statement).toContain(
        'GROUP BY 1, model, auto_model'
      );
    }
  );

  it.each(['personal', 'include-orgs', 'self', 'org-wide', 'multi-org'] as const)(
    'preserves %s authorization and scope with aliases',
    async scope => {
      const scoped =
        scope === 'personal'
          ? {}
          : scope === 'include-orgs'
            ? { personalScope: 'include-orgs' as const }
            : scope === 'multi-org'
              ? { organizationIds: [PARENT_ORG, CHILD_ORG_A] }
              : { organizationId: PARENT_ORG, viewAs: scope };
      await invokeAll({ ...baseFilters, ...scoped, autoModels: ['Balanced'] });
      for (const [r] of mockExecuteSnowflakeStatement.mock.calls) {
        const values = r.bindings?.map(b => b.value) ?? [];
        expect(values).toContain('Balanced');
        if (scope === 'multi-org') {
          expect(r.statement).toContain('organization_id IN (?, ?)');
          expect(values).toEqual(['2026-06-04', '2026-06-05', PARENT_ORG, CHILD_ORG_A, 'Balanced']);
        } else if (scope === 'org-wide') {
          expect(values).toEqual(['2026-06-04', '2026-06-05', PARENT_ORG, 'Balanced']);
        } else {
          expect(r.statement).toContain('kilo_user_id = ?');
          expect(values).toContain(CTX_USER);
          if (scope === 'self') expect(values).toContain(PARENT_ORG);
          if (scope === 'personal') expect(values).toContain('');
          if (scope === 'include-orgs') expect(r.statement).not.toContain('organization_id = ?');
        }
      }
      if (scope === 'multi-org')
        expect(ensureOrganizationsAccess).toHaveBeenCalledWith(
          expect.anything(),
          [PARENT_ORG, CHILD_ORG_A],
          ['owner', 'admin', 'billing_manager']
        );
      if (scope === 'org-wide')
        expect(ensureOrganizationAccess).toHaveBeenCalledWith(expect.anything(), PARENT_ORG, [
          'owner',
          'admin',
          'billing_manager',
        ]);
      if (scope === 'self')
        expect(ensureOrganizationAccess).toHaveBeenCalledWith(
          expect.anything(),
          PARENT_ORG,
          undefined
        );
    }
  );

  it.each(['personal', 'self', 'org-wide', 'multi-org'] as const)(
    'denies %s before any warehouse query despite an alias',
    async scope => {
      jest.mocked(ensureOrganizationAccess).mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
      jest
        .mocked(ensureOrganizationsAccess)
        .mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
      const scoped =
        scope === 'personal'
          ? { userIds: ['other'] }
          : scope === 'multi-org'
            ? { organizationIds: [PARENT_ORG, CHILD_ORG_A] }
            : { organizationId: PARENT_ORG, viewAs: scope };
      const f = { ...baseFilters, ...scoped, autoModels: ['Balanced'] };
      const invokes = [
        () => caller().getSummary(f),
        () => caller().getTimeseries({ ...f, metric: 'cost' }),
        () => caller().getBreakdown({ ...f, dimension: 'model', metric: 'cost' }),
        () => caller().getTable({ ...f, groupBy: [] }),
      ];
      for (const invoke of invokes)
        await expect(invoke()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockExecuteSnowflakeStatement).not.toHaveBeenCalled();
    }
  );

  it('leaves default requests and empty alias lists identical', async () => {
    await invokeAll(baseFilters);
    const defaults = mockExecuteSnowflakeStatement.mock.calls.map(([r]) => ({
      statement: r.statement,
      bindings: r.bindings,
    }));
    jest.clearAllMocks();
    await invokeAll({ ...baseFilters, autoModels: [], excludedAutoModels: [] });
    expect(
      mockExecuteSnowflakeStatement.mock.calls.map(([r]) => ({
        statement: r.statement,
        bindings: r.bindings,
      }))
    ).toEqual(defaults);
    for (const r of defaults) expect(r.statement).not.toContain('auto_model');
  });

  it.each(['autoModels', 'excludedAutoModels'])(
    'bounds %s and rejects injected dimensions',
    field => {
      expect(
        UsageAnalyticsFiltersSchema.safeParse({
          ...baseFilters,
          [field]: Array(MAX_FILTER_VALUES + 1).fill('a'),
        }).success
      ).toBe(false);
      expect(
        UsageAnalyticsFiltersSchema.safeParse({
          ...baseFilters,
          [field]: ['a'.repeat(MAX_FILTER_VALUE_LENGTH + 1)],
        }).success
      ).toBe(false);
      expect(
        UsageAnalyticsFiltersSchema.parse({ ...baseFilters, [field]: ['unknown', ''] })[
          field as 'autoModels'
        ]
      ).toEqual(['unknown', '']);
      expect(
        TableInputSchema.safeParse({ ...baseFilters, groupBy: ['auto_model; DROP TABLE usage'] })
          .success
      ).toBe(false);
      expect(
        TableInputSchema.safeParse({
          ...baseFilters,
          groupBy: ['autoModel', 'model', 'provider', 'feature'],
        }).success
      ).toBe(false);
    }
  );
});
