jest.mock('@/lib/redis', () => ({ redisClient: {} }));

import {
  aggregateDisplayedBreakdownValues,
  CostSourceSchema,
  UsageAnalyticsFiltersSchema,
  applySelfEmailExclusion,
  buildScopedUserEmailMaps,
  costColumnFor,
  costSumExprSql,
  dimensionDisplayValue,
  shouldLoadFullOrgWideUserEmailMap,
  userDisplayValue,
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

  it('coalesces breakdown values by displayed user email before limiting', () => {
    const userEmailsById = new Map([
      ['user_1', 'person@example.com'],
      ['oauth/github:123', 'person@example.com'],
      ['user_2', 'other@example.com'],
    ]);

    expect(
      aggregateDisplayedBreakdownValues(
        'user',
        { userDisplay: 'email' },
        userEmailsById,
        [
          { key: 'user_2', value: 80 },
          { key: 'user_1', value: 60 },
          { key: 'oauth/github:123', value: 50 },
          { key: 'missing_user_1', value: 6 },
          { key: 'missing_user_2', value: 4 },
        ],
        2
      )
    ).toEqual([
      { key: 'person@example.com', value: 110 },
      { key: 'other@example.com', value: 80 },
    ]);
  });
});
