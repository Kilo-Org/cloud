import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { db } from '@/lib/drizzle';
import {
  contributor_champion_contributors,
  contributor_champion_events,
  contributor_champion_memberships,
  contributor_champion_sync_state,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { fetchWithBackoff } from '@/lib/fetchWithBackoff';
import {
  enrollContributorChampion,
  getContributorChampionLeaderboard,
  getContributorChampionProfileBadgeForUser,
  getContributorChampionReviewQueue,
  getEnrolledContributorChampions,
  syncContributorChampionData,
  upsertContributorSelectedTier,
} from './service';

jest.mock('@/lib/config.server', () => ({
  GITHUB_ADMIN_STATS_TOKEN: 'test-github-token',
}));

jest.mock('@/lib/fetchWithBackoff', () => ({
  fetchWithBackoff: jest.fn(),
}));

const mockedFetchWithBackoff = fetchWithBackoff as jest.MockedFunction<typeof fetchWithBackoff>;

function toUrl(input: string | URL | Request): URL {
  if (typeof input === 'string' || input instanceof URL) {
    return new URL(input);
  }
  return new URL(input.url);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERROR',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

async function insertContributor(input: { login: string; allTimeContributions: number }) {
  const rows = await db
    .insert(contributor_champion_contributors)
    .values({
      github_login: input.login,
      github_profile_url: `https://github.com/${input.login}`,
      all_time_contributions: input.allTimeContributions,
      first_contribution_at: daysAgo(200),
      last_contribution_at: daysAgo(1),
    })
    .returning({ id: contributor_champion_contributors.id });

  return rows[0].id;
}

async function insertEvent(input: {
  contributorId: string;
  prNumber: number;
  mergedAt: string;
  login: string;
  email?: string | null;
}) {
  await db.insert(contributor_champion_events).values({
    contributor_id: input.contributorId,
    repo_full_name: 'Kilo-Org/kilocode',
    github_pr_number: input.prNumber,
    github_pr_url: `https://github.com/Kilo-Org/kilocode/pull/${input.prNumber}`,
    github_pr_title: `PR ${input.prNumber}`,
    github_author_login: input.login,
    github_author_email: input.email ?? null,
    merged_at: input.mergedAt,
  });
}

describe('contributor champions service', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await db.delete(contributor_champion_memberships);
    await db.delete(contributor_champion_events);
    await db.delete(contributor_champion_sync_state);
    await db.delete(contributor_champion_contributors);
  });

  it('computes suggested tier boundaries for contributor, ambassador, and champion', async () => {
    const belowContributorId = await insertContributor({
      login: 'below-contributor',
      allTimeContributions: 14,
    });
    const contributorBoundaryId = await insertContributor({
      login: 'contributor-boundary',
      allTimeContributions: 14,
    });
    const ambassadorBoundaryId = await insertContributor({
      login: 'ambassador-boundary',
      allTimeContributions: 14,
    });
    const championBoundaryId = await insertContributor({
      login: 'champion-boundary',
      allTimeContributions: 15,
    });

    for (let index = 0; index < 4; index += 1) {
      await insertEvent({
        contributorId: belowContributorId,
        prNumber: 1_000 + index,
        mergedAt: daysAgo(10),
        login: 'below-contributor',
      });
    }

    await insertEvent({
      contributorId: contributorBoundaryId,
      prNumber: 2_000,
      mergedAt: daysAgo(89),
      login: 'contributor-boundary',
    });

    for (let index = 0; index < 5; index += 1) {
      await insertEvent({
        contributorId: ambassadorBoundaryId,
        prNumber: 3_000 + index,
        mergedAt: daysAgo(2),
        login: 'ambassador-boundary',
      });
    }

    await insertEvent({
      contributorId: championBoundaryId,
      prNumber: 4_000,
      mergedAt: daysAgo(200),
      login: 'champion-boundary',
    });

    const leaderboard = await getContributorChampionLeaderboard();
    const byLogin = new Map(leaderboard.map(row => [row.githubLogin, row]));

    expect(byLogin.get('below-contributor')?.suggestedTier).toBe('contributor');
    expect(byLogin.get('contributor-boundary')?.contributions90d).toBe(1);
    expect(byLogin.get('contributor-boundary')?.suggestedTier).toBe('contributor');
    expect(byLogin.get('ambassador-boundary')?.contributions90d).toBe(5);
    expect(byLogin.get('ambassador-boundary')?.suggestedTier).toBe('ambassador');
    expect(byLogin.get('champion-boundary')?.contributionsAllTime).toBe(15);
    expect(byLogin.get('champion-boundary')?.suggestedTier).toBe('champion');
  });

  it('supports selected tier and enrollment workflow transitions', async () => {
    const contributorId = await insertContributor({
      login: 'review-candidate',
      allTimeContributions: 5,
    });

    for (let index = 0; index < 5; index += 1) {
      await insertEvent({
        contributorId,
        prNumber: 5_000 + index,
        mergedAt: daysAgo(7),
        login: 'review-candidate',
      });
    }

    const reviewQueueBefore = await getContributorChampionReviewQueue();
    expect(reviewQueueBefore.map(row => row.contributorId)).toContain(contributorId);

    await upsertContributorSelectedTier({
      contributorId,
      selectedTier: 'champion',
    });

    const leaderboardAfterSelection = await getContributorChampionLeaderboard();
    const selectedRow = leaderboardAfterSelection.find(row => row.contributorId === contributorId);
    expect(selectedRow?.selectedTier).toBe('champion');

    const enrollmentResult = await enrollContributorChampion({ contributorId, tier: null });
    expect(enrollmentResult.enrolledTier).toBe('champion');

    const membership = await db.query.contributor_champion_memberships.findFirst({
      where: eq(contributor_champion_memberships.contributor_id, contributorId),
    });
    expect(membership?.selected_tier).toBe('champion');
    expect(membership?.enrolled_tier).toBe('champion');
    expect(membership?.enrolled_at).not.toBeNull();

    const enrolled = await getEnrolledContributorChampions();
    expect(enrolled.map(row => row.contributorId)).toContain(contributorId);

    const reviewQueueAfter = await getContributorChampionReviewQueue();
    expect(reviewQueueAfter.map(row => row.contributorId)).not.toContain(contributorId);
  });

  it('sync is idempotent, excludes team members, and updates rolling/all-time counts', async () => {
    mockedFetchWithBackoff.mockImplementation(async url => {
      const parsedUrl = toUrl(url);
      if (parsedUrl.pathname.endsWith('/search/issues') && parsedUrl.searchParams.get('page') === '1') {
        return jsonResponse({
          total_count: 2,
          items: [
            {
              number: 7101,
              html_url: 'https://github.com/Kilo-Org/kilocode/pull/7101',
              title: 'External contribution 1',
              pull_request: {
                merged_at: daysAgo(30),
              },
              user: {
                login: 'external-contributor',
                id: 999001,
                type: 'User',
                html_url: 'https://github.com/external-contributor',
              },
            },
            {
              number: 7102,
              html_url: 'https://github.com/Kilo-Org/kilocode/pull/7102',
              title: 'Internal team PR',
              pull_request: {
                merged_at: daysAgo(29),
              },
              user: {
                login: 'brianturcotte',
                id: 999002,
                type: 'User',
                html_url: 'https://github.com/brianturcotte',
              },
            },
          ],
        });
      }

      if (parsedUrl.pathname.endsWith('/pulls/7101/commits')) {
        return jsonResponse([
          {
            author: { login: 'external-contributor' },
            commit: { author: { email: 'external-contributor@example.com' } },
          },
        ]);
      }

      if (parsedUrl.pathname.endsWith('/search/issues') && parsedUrl.searchParams.get('page') === '2') {
        return jsonResponse({
          total_count: 2,
          items: [],
        });
      }

      throw new Error(`Unexpected GitHub request in test: ${url}`);
    });

    const firstSync = await syncContributorChampionData();
    expect(firstSync.insertedContributionEvents).toBe(1);
    expect(firstSync.fetchedMergedPullRequests).toBe(1);

    const firstEvents = await db.select().from(contributor_champion_events);
    expect(firstEvents).toHaveLength(1);
    expect(firstEvents[0]?.github_author_login).toBe('external-contributor');

    mockedFetchWithBackoff.mockImplementation(async url => {
      const parsedUrl = toUrl(url);
      if (parsedUrl.pathname.endsWith('/search/issues') && parsedUrl.searchParams.get('page') === '1') {
        return jsonResponse({
          total_count: 1,
          items: [
            {
              number: 7103,
              html_url: 'https://github.com/Kilo-Org/kilocode/pull/7103',
              title: 'External contribution 2',
              pull_request: {
                merged_at: daysAgo(5),
              },
              user: {
                login: 'external-contributor',
                id: 999001,
                type: 'User',
                html_url: 'https://github.com/external-contributor',
              },
            },
          ],
        });
      }

      if (parsedUrl.pathname.endsWith('/pulls/7103/commits')) {
        return jsonResponse([
          {
            author: { login: 'external-contributor' },
            commit: { author: { email: 'external-contributor@example.com' } },
          },
        ]);
      }

      throw new Error(`Unexpected GitHub request in test: ${url}`);
    });

    const secondSync = await syncContributorChampionData();
    expect(secondSync.insertedContributionEvents).toBe(1);

    const leaderboardAfterSecondSync = await getContributorChampionLeaderboard();
    const contributorRow = leaderboardAfterSecondSync.find(
      row => row.githubLogin === 'external-contributor'
    );
    expect(contributorRow?.contributionsAllTime).toBe(2);
    expect(contributorRow?.contributions90d).toBe(2);

    mockedFetchWithBackoff.mockImplementation(async url => {
      const parsedUrl = toUrl(url);
      if (parsedUrl.pathname.endsWith('/search/issues') && parsedUrl.searchParams.get('page') === '1') {
        return jsonResponse({
          total_count: 1,
          items: [
            {
              number: 7103,
              html_url: 'https://github.com/Kilo-Org/kilocode/pull/7103',
              title: 'External contribution 2',
              pull_request: {
                merged_at: daysAgo(5),
              },
              user: {
                login: 'external-contributor',
                id: 999001,
                type: 'User',
                html_url: 'https://github.com/external-contributor',
              },
            },
          ],
        });
      }

      throw new Error(`Unexpected GitHub request in test: ${url}`);
    });

    const thirdSync = await syncContributorChampionData();
    expect(thirdSync.insertedContributionEvents).toBe(0);

    const allEvents = await db.select().from(contributor_champion_events);
    expect(allEvents).toHaveLength(2);
  });

  it('returns profile badge only for enrolled memberships', async () => {
    const user = await insertTestUser({ google_user_email: 'badge-user@example.com' });
    const contributorId = await insertContributor({
      login: 'badge-user',
      allTimeContributions: 10,
    });

    await insertEvent({
      contributorId,
      prNumber: 8_001,
      mergedAt: daysAgo(1),
      login: 'badge-user',
      email: 'badge-user@example.com',
    });

    await db.insert(contributor_champion_memberships).values({
      contributor_id: contributorId,
      selected_tier: 'ambassador',
      enrolled_tier: null,
      enrolled_at: null,
    });

    const beforeEnrollment = await getContributorChampionProfileBadgeForUser({ userId: user.id });
    expect(beforeEnrollment).toBeNull();

    await db
      .update(contributor_champion_memberships)
      .set({
        enrolled_tier: 'ambassador',
        enrolled_at: new Date().toISOString(),
      })
      .where(eq(contributor_champion_memberships.contributor_id, contributorId));

    const afterEnrollment = await getContributorChampionProfileBadgeForUser({ userId: user.id });
    expect(afterEnrollment?.tier).toBe('ambassador');
    expect(afterEnrollment?.enrolledAt).toBeTruthy();
  });
});
