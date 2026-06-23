jest.mock('@/lib/redis', () => ({ redisClient: {} }));

jest.mock('@/lib/snowflake', () => ({
  executeSnowflakeStatement: jest.fn(),
  resolveSnowflakeConfig: jest.fn(() => ({ account: 'test-account' })),
}));

jest.mock('@/lib/drizzle', () => ({
  readDb: { select: jest.fn() },
}));

import type { User } from '@kilocode/db/schema';
import { readDb } from '@/lib/drizzle';
import { executeSnowflakeStatement } from '@/lib/snowflake';
import { createCallerFactory } from '@/lib/trpc/init';
import {
  CostSourceSchema,
  UsageAnalyticsFiltersSchema,
  applySelfEmailExclusion,
  buildWhereClause,
  buildScopedUserEmailMaps,
  costColumnFor,
  costSumExprSql,
  dimensionDisplayValue,
  displayBreakdownValues,
  scopedUserEmailBreakdownIds,
  shouldLoadFullOrgWideUserEmailMap,
  userEmailMapValuesSql,
  userDisplayValue,
  usageAnalyticsRouter,
} from './usage-analytics-router';

const baseFilters = {
  startDate: '2026-06-04T00:00:00.000Z',
  endDate: '2026-06-05T00:00:00.000Z',
  granularity: 'day' as const,
};

const createCaller = createCallerFactory(usageAnalyticsRouter);
const mockExecuteSnowflakeStatement = jest.mocked(executeSnowflakeStatement);
const mockReadDbSelect = jest.mocked(readDb.select);
const mockAuthProviderRows: Array<{
  userId: string;
  provider: 'github' | 'google';
  providerAccountId: string;
}> = [];

function createUsageAnalyticsCaller() {
  return createCaller({
    user: {
      id: 'user_1',
      google_user_email: 'person@example.com',
      is_admin: false,
    } as User,
  });
}

describe('usage analytics cost source', () => {
  beforeEach(() => {
    mockExecuteSnowflakeStatement.mockReset();
    mockExecuteSnowflakeStatement.mockResolvedValue([['person@example.com', '110']]);
    mockAuthProviderRows.splice(0, mockAuthProviderRows.length);
    mockReadDbSelect.mockReturnValue({
      from: jest.fn(() => ({
        where: jest.fn(async () => mockAuthProviderRows),
      })),
    } as never);
  });

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

  it('accepts email-based user filtering and email display mode', () => {
    const filters = UsageAnalyticsFiltersSchema.parse({
      ...baseFilters,
      userEmails: ['person@example.com'],
      excludedUserEmails: ['excluded@example.com'],
      userDisplay: 'email',
    });

    expect(filters.userEmails).toEqual(['person@example.com']);
    expect(filters.excludedUserEmails).toEqual(['excluded@example.com']);
    expect(filters.userDisplay).toBe('email');
  });

  it('builds scoped email maps with canonical and legacy OAuth user ids', () => {
    const maps = buildScopedUserEmailMaps(
      [
        { id: 'user_1', email: 'person@example.com' },
        { id: 'user_2', email: 'other@example.com' },
        { id: 'user_without_email', email: null },
      ],
      [
        { userId: 'user_1', provider: 'github', providerAccountId: '123' },
        { userId: 'user_1', provider: 'google', providerAccountId: 'abc' },
        { userId: 'missing_user', provider: 'github', providerAccountId: 'ignored' },
      ]
    );

    expect(maps.idsByEmail.get('person@example.com')).toEqual([
      'user_1',
      'oauth/github:123',
      'oauth/google:abc',
    ]);
    expect(maps.idsByEmail.get('other@example.com')).toEqual(['user_2']);
    expect(maps.emailsById.get('user_1')).toBe('person@example.com');
    expect(maps.emailsById.get('oauth/github:123')).toBe('person@example.com');
    expect(maps.emailsById.has('oauth/github:ignored')).toBe(false);
    expect(maps.emailsById.has('user_without_email')).toBe(false);
  });

  it('translates self-scope excluded user emails to excluded user ids', () => {
    const filters = UsageAnalyticsFiltersSchema.parse({
      ...baseFilters,
      excludedUserEmails: ['person@example.com'],
    });

    expect(
      applySelfEmailExclusion(filters, 'user_1', 'person@example.com').excludedUserIds
    ).toEqual(['user_1']);
    expect(applySelfEmailExclusion(filters, 'user_1', 'other@example.com').excludedUserIds).toBe(
      undefined
    );
  });

  it('loads full org email maps only for email display requests', () => {
    const filters = UsageAnalyticsFiltersSchema.parse({
      ...baseFilters,
      organizationId: '00000000-0000-4000-8000-000000000001',
      viewAs: 'org-wide',
      userEmails: ['person@example.com'],
    });

    expect(shouldLoadFullOrgWideUserEmailMap(filters, false)).toBe(false);
    expect(shouldLoadFullOrgWideUserEmailMap(filters, true)).toBe(false);
    expect(shouldLoadFullOrgWideUserEmailMap({ ...filters, userDisplay: 'email' }, true)).toBe(
      true
    );
  });

  it('does not fall back to raw user ids for unmapped email display values', () => {
    const userEmailsById = new Map([['user_1', 'person@example.com']]);

    expect(userDisplayValue({ userDisplay: 'email' }, userEmailsById, 'user_1')).toBe(
      'person@example.com'
    );
    expect(userDisplayValue({ userDisplay: 'email' }, userEmailsById, 'missing_user')).toBe('');
    expect(userDisplayValue({ userDisplay: 'id' }, userEmailsById, 'missing_user')).toBe(
      'missing_user'
    );
    expect(dimensionDisplayValue('model', { userDisplay: 'email' }, userEmailsById, 'claude')).toBe(
      'claude'
    );
  });

  it('aggregates breakdown user ids by email before applying the display limit', () => {
    const userEmailsById = new Map([
      ['user_1', 'person@example.com'],
      ['oauth/github:123', 'person@example.com'],
      ['user_2', 'other@example.com'],
    ]);

    expect(
      displayBreakdownValues(
        'user',
        { userDisplay: 'email' },
        userEmailsById,
        [
          { key: 'user_2', label: 'user_2', value: 80 },
          { key: 'user_1', label: 'user_1', value: 60 },
          { key: 'oauth/github:123', label: 'oauth/github:123', value: 50 },
          { key: 'missing_user_1', label: 'missing_user_1', value: 6 },
          { key: 'missing_user_2', label: 'missing_user_2', value: 4 },
        ],
        2
      )
    ).toEqual([
      { key: 'person@example.com', label: 'person@example.com', value: 110 },
      { key: 'other@example.com', label: 'other@example.com', value: 80 },
    ]);
  });

  it('builds bound SQL values for email-display user aggregation', () => {
    const maps = buildScopedUserEmailMaps(
      [
        { id: 'user_1', email: 'person@example.com' },
        { id: 'user_2', email: 'other@example.com' },
      ],
      [{ userId: 'user_1', provider: 'github', providerAccountId: '123' }]
    );

    const values = userEmailMapValuesSql(maps);

    expect(values?.valuesSql).toBe('(?, ?), (?, ?), (?, ?)');
    expect(values?.valuesSql).not.toContain('person@example.com');
    expect(values?.valuesSql).not.toContain('oauth/github:123');
    expect(values?.bindings).toEqual([
      { type: 'TEXT', value: 'user_1' },
      { type: 'TEXT', value: 'person@example.com' },
      { type: 'TEXT', value: 'user_2' },
      { type: 'TEXT', value: 'other@example.com' },
      { type: 'TEXT', value: 'oauth/github:123' },
      { type: 'TEXT', value: 'person@example.com' },
    ]);
  });

  it('getBreakdown aggregates email-display user buckets in SQL before limiting', async () => {
    mockAuthProviderRows.push({
      userId: 'user_1',
      provider: 'github',
      providerAccountId: '123',
    });

    const caller = createUsageAnalyticsCaller();

    await caller.getBreakdown({
      ...baseFilters,
      dimension: 'user',
      metric: 'cost',
      userDisplay: 'email',
      limit: 2,
    });

    expect(mockExecuteSnowflakeStatement).toHaveBeenCalledTimes(1);
    const statement = mockExecuteSnowflakeStatement.mock.calls[0][0].statement as string;
    expect(statement).toContain('WITH user_email_map(mapped_user_id, mapped_email) AS');
    expect(statement).toContain('FROM VALUES (?, ?), (?, ?)');
    expect(statement).toContain('JOIN user_email_map ON kilo_user_id = mapped_user_id');
    expect(statement).toContain('mapped_email AS key');
    expect(statement).toContain('GROUP BY 1');
    expect(statement).toContain('ORDER BY 2 DESC');
    expect(statement).toContain('LIMIT 2');
    expect(statement).not.toContain('person@example.com');
    expect(statement).not.toContain('oauth/github:123');
  });

  it('getBreakdown wires scoped self email identities into the self-scope predicate', async () => {
    mockAuthProviderRows.push({
      userId: 'user_1',
      provider: 'github',
      providerAccountId: '123',
    });

    const caller = createUsageAnalyticsCaller();

    await caller.getBreakdown({
      ...baseFilters,
      dimension: 'user',
      metric: 'cost',
      userDisplay: 'email',
      limit: 2,
    });

    const call = mockExecuteSnowflakeStatement.mock.calls[0][0];
    const statement = call.statement as string;
    expect(statement).toContain('kilo_user_id IN (?, ?)');
    expect(statement).not.toContain('kilo_user_id = ?');
    expect(call.bindings).toEqual([
      { type: 'TEXT', value: 'user_1' },
      { type: 'TEXT', value: 'person@example.com' },
      { type: 'TEXT', value: 'oauth/github:123' },
      { type: 'TEXT', value: 'person@example.com' },
      { type: 'TEXT', value: '2026-06-04' },
      { type: 'TEXT', value: '2026-06-05' },
      { type: 'TEXT', value: 'user_1' },
      { type: 'TEXT', value: 'oauth/github:123' },
      { type: 'TEXT', value: '' },
    ]);
  });

  it('uses scoped self ids instead of intersecting email breakdowns with the canonical user id', () => {
    const filters = UsageAnalyticsFiltersSchema.parse({
      ...baseFilters,
      userDisplay: 'email',
    });

    const where = buildWhereClause('daily', filters, 'user_1', true, [
      'user_1',
      'oauth/github:123',
    ]);

    expect(where.sql()).toContain('kilo_user_id IN (?, ?)');
    expect(where.sql()).not.toContain('kilo_user_id = ?');
    expect(where.bindings.map(binding => binding.value)).toEqual(
      expect.arrayContaining(['user_1', 'oauth/github:123'])
    );
  });

  it('uses scoped self ids for organization self-scope email breakdowns', () => {
    const filters = UsageAnalyticsFiltersSchema.parse({
      ...baseFilters,
      organizationId: '00000000-0000-4000-8000-000000000001',
      viewAs: 'self',
      userDisplay: 'email',
    });

    const where = buildWhereClause('daily', filters, 'user_1', true, [
      'user_1',
      'oauth/github:123',
    ]);

    expect(where.sql()).toContain('organization_id = ?');
    expect(where.sql()).toContain('kilo_user_id IN (?, ?)');
    expect(where.sql()).not.toContain('kilo_user_id = ?');
    expect(where.bindings.map(binding => binding.value)).toEqual(
      expect.arrayContaining(['00000000-0000-4000-8000-000000000001', 'user_1', 'oauth/github:123'])
    );
  });

  it('scopes email-display user breakdown queries to mapped user identities', () => {
    const maps = buildScopedUserEmailMaps(
      [
        { id: 'user_1', email: 'person@example.com' },
        { id: 'user_2', email: 'other@example.com' },
      ],
      [
        { userId: 'user_1', provider: 'github', providerAccountId: '123' },
        { userId: 'user_1', provider: 'github', providerAccountId: '123' },
        { userId: 'user_2', provider: 'google', providerAccountId: 'abc' },
      ]
    );

    expect(scopedUserEmailBreakdownIds('user', { userDisplay: 'email' }, maps)).toEqual([
      'user_1',
      'oauth/github:123',
      'user_2',
      'oauth/google:abc',
    ]);
    expect(scopedUserEmailBreakdownIds('user', { userDisplay: 'id' }, maps)).toBe(undefined);
    expect(scopedUserEmailBreakdownIds('model', { userDisplay: 'email' }, maps)).toBe(undefined);
  });
});
