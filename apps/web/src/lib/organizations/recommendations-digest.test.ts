import { buildOrganizationRecommendationsDigest } from './recommendations-digest';

jest.mock('./recommendations', () => ({
  getOrganizationRecommendations: jest.fn(),
}));

import { getOrganizationRecommendations } from './recommendations';

const mockedGetRecommendations = getOrganizationRecommendations as jest.MockedFunction<
  typeof getOrganizationRecommendations
>;

type ResolvedRecommendations = Awaited<ReturnType<typeof getOrganizationRecommendations>>;

function check(adopted: boolean) {
  return {
    key: 'source-control-integration',
    title: 'Source control',
    description: 'desc',
    adopted,
    adoptedLabel: 'Connected',
    notAdoptedLabel: 'Not connected',
    actionLabel: 'Connect',
    actionUrl: '/x',
  };
}

function recommendation(status: 'open' | 'completed' | 'dismissed', index: number) {
  return {
    key: `rec-${index}`,
    feature: 'code-reviewer',
    status,
    title: `Title ${index}`,
    description: `Description ${index}`,
    actionLabel: `Action ${index}`,
    actionUrl: `/organizations/org/setting-${index}`,
    severity: 'suggestion',
  };
}

function mockResolved(
  plan: 'teams' | 'enterprise',
  checks: ReturnType<typeof check>[],
  recommendations: ReturnType<typeof recommendation>[]
) {
  mockedGetRecommendations.mockResolvedValue({
    plan,
    checks,
    recommendations,
  } as unknown as ResolvedRecommendations);
}

describe('buildOrganizationRecommendationsDigest', () => {
  beforeEach(() => {
    mockedGetRecommendations.mockReset();
  });

  it('returns null for non-enterprise organizations', async () => {
    mockResolved('teams', [], []);

    const result = await buildOrganizationRecommendationsDigest('org-1', 'Acme');

    expect(result).toBeNull();
  });

  it('returns null when there are no open recommendations (skip-empty)', async () => {
    mockResolved(
      'enterprise',
      [check(true), check(true)],
      [recommendation('completed', 0), recommendation('dismissed', 1)]
    );

    const result = await buildOrganizationRecommendationsDigest('org-1', 'Acme');

    expect(result).toBeNull();
  });

  it('builds the payload with adoption counts and only open recommendations', async () => {
    mockResolved(
      'enterprise',
      [check(true), check(true), check(true), check(false), check(false), check(false)],
      [recommendation('open', 0), recommendation('completed', 1), recommendation('open', 2)]
    );

    const result = await buildOrganizationRecommendationsDigest('org-1', 'Acme');

    expect(result).not.toBeNull();
    expect(result?.organizationName).toBe('Acme');
    expect(result?.adoptedCount).toBe(3);
    expect(result?.totalCount).toBe(6);
    expect(result?.openCount).toBe(2);
    expect(result?.recommendations.map(r => r.title)).toEqual(['Title 0', 'Title 2']);
  });

  it('caps the listed recommendations at three but keeps the full open count', async () => {
    const openRecs = Array.from({ length: 5 }, (_, i) => recommendation('open', i));
    mockResolved('enterprise', [check(true)], openRecs);

    const result = await buildOrganizationRecommendationsDigest('org-1', 'Acme');

    expect(result?.openCount).toBe(5);
    expect(result?.recommendations).toHaveLength(3);
    expect(result?.recommendations.map(r => r.title)).toEqual(['Title 0', 'Title 1', 'Title 2']);
  });
});
