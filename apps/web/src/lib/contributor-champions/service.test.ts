import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { db } from '@/lib/drizzle';
import {
  contributor_champion_contributors,
  contributor_champion_events,
  contributor_champion_memberships,
  contributor_champion_sync_state,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { fetchWithBackoff as fetchWithBackoffType } from '@/lib/fetchWithBackoff';
import type { grantCreditForCategory as grantCreditForCategoryType } from '@/lib/promotionalCredits';
import type * as serviceModule from './service';

const mockedFetchWithBackoff = jest.fn() as jest.MockedFunction<typeof fetchWithBackoffType>;
const mockedGrantCredit = jest.fn() as jest.MockedFunction<typeof grantCreditForCategoryType>;

jest.mock('@/lib/config.server', () => ({
  GITHUB_ADMIN_STATS_TOKEN: 'test-github-token',
}));

jest.mock('@/lib/fetchWithBackoff', () => ({
  fetchWithBackoff: mockedFetchWithBackoff,
}));

jest.mock('@/lib/promotionalCredits', () => ({
  grantCreditForCategory: mockedGrantCredit,
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

let enrollContributorChampion: typeof serviceModule.enrollContributorChampion;
let getContributorChampionLeaderboard: typeof serviceModule.getContributorChampionLeaderboard;
let getContributorChampionProfileBadgeForUser: typeof serviceModule.getContributorChampionProfileBadgeForUser;
let getContributorChampionReviewQueue: typeof serviceModule.getContributorChampionReviewQueue;
let getEnrolledContributorChampions: typeof serviceModule.getEnrolledContributorChampions;
let manualEnrollContributor: typeof serviceModule.manualEnrollContributor;
let processAutoTierUpgrades: typeof serviceModule.processAutoTierUpgrades;
let refreshContributorChampionCredits: typeof serviceModule.refreshContributorChampionCredits;
let searchKiloUsersByEmail: typeof serviceModule.searchKiloUsersByEmail;
let syncContributorChampionData: typeof serviceModule.syncContributorChampionData;
let upsertContributorSelectedTier: typeof serviceModule.upsertContributorSelectedTier;

beforeAll(async () => {
  ({
    enrollContributorChampion,
    getContributorChampionLeaderboard,
    getContributorChampionProfileBadgeForUser,
    getContributorChampionReviewQueue,
    getEnrolledContributorChampions,
    manualEnrollContributor,
    processAutoTierUpgrades,
    refreshContributorChampionCredits,
    searchKiloUsersByEmail,
    syncContributorChampionData,
    upsertContributorSelectedTier,
  } = await import('./service'));
});

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
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(contributor_champion_memberships);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(contributor_champion_events);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(contributor_champion_sync_state);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
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
      if (
        parsedUrl.pathname.endsWith('/search/issues') &&
        parsedUrl.searchParams.get('page') === '1'
      ) {
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

      if (
        parsedUrl.pathname.endsWith('/search/issues') &&
        parsedUrl.searchParams.get('page') === '2'
      ) {
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
      if (
        parsedUrl.pathname.endsWith('/search/issues') &&
        parsedUrl.searchParams.get('page') === '1'
      ) {
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
      if (
        parsedUrl.pathname.endsWith('/search/issues') &&
        parsedUrl.searchParams.get('page') === '1'
      ) {
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

  it('processAutoTierUpgrades upgrades contributor to ambassador at 5 PRs and ambassador to champion at 15 PRs', async () => {
    const contributorId = await insertContributor({
      login: 'upgrade-candidate',
      allTimeContributions: 5,
    });
    const alreadyChampionId = await insertContributor({
      login: 'already-champion',
      allTimeContributions: 20,
    });
    const staysContributorId = await insertContributor({
      login: 'stays-contributor',
      allTimeContributions: 3,
    });

    await insertEvent({
      contributorId,
      prNumber: 9_000,
      mergedAt: daysAgo(10),
      login: 'upgrade-candidate',
    });
    await insertEvent({
      contributorId: alreadyChampionId,
      prNumber: 9_001,
      mergedAt: daysAgo(10),
      login: 'already-champion',
    });
    await insertEvent({
      contributorId: staysContributorId,
      prNumber: 9_002,
      mergedAt: daysAgo(10),
      login: 'stays-contributor',
    });

    await db.insert(contributor_champion_memberships).values([
      {
        contributor_id: contributorId,
        enrolled_tier: 'contributor',
        enrolled_at: daysAgo(60),
        credit_amount_microdollars: 0,
      },
      {
        contributor_id: alreadyChampionId,
        enrolled_tier: 'champion',
        enrolled_at: daysAgo(60),
        credit_amount_microdollars: 150_000_000,
      },
      {
        contributor_id: staysContributorId,
        enrolled_tier: 'contributor',
        enrolled_at: daysAgo(60),
        credit_amount_microdollars: 0,
      },
    ]);

    const result = await processAutoTierUpgrades();

    expect(result.upgraded).toBe(1);
    expect(result.upgrades).toHaveLength(1);
    expect(result.upgrades[0]?.fromTier).toBe('contributor');
    expect(result.upgrades[0]?.toTier).toBe('ambassador');

    const membership = await db.query.contributor_champion_memberships.findFirst({
      where: eq(contributor_champion_memberships.contributor_id, contributorId),
    });
    expect(membership?.enrolled_tier).toBe('ambassador');

    const championMembership = await db.query.contributor_champion_memberships.findFirst({
      where: eq(contributor_champion_memberships.contributor_id, alreadyChampionId),
    });
    expect(championMembership?.enrolled_tier).toBe('champion');

    const staysMembership = await db.query.contributor_champion_memberships.findFirst({
      where: eq(contributor_champion_memberships.contributor_id, staysContributorId),
    });
    expect(staysMembership?.enrolled_tier).toBe('contributor');
  });

  it('refreshContributorChampionCredits grants credits for enrolled members with linked users', async () => {
    const user = await insertTestUser({ google_user_email: 'credit-user@example.com' });
    const contributorId = await insertContributor({
      login: 'credit-contributor',
      allTimeContributions: 10,
    });
    await insertEvent({
      contributorId,
      prNumber: 10_000,
      mergedAt: daysAgo(10),
      login: 'credit-contributor',
      email: 'credit-user@example.com',
    });

    await db.insert(contributor_champion_memberships).values({
      contributor_id: contributorId,
      enrolled_tier: 'ambassador',
      enrolled_at: daysAgo(60),
      credit_amount_microdollars: 50_000_000,
      linked_kilo_user_id: user.id,
      credits_last_granted_at: null,
    });

    mockedGrantCredit.mockResolvedValue({
      success: true,
      message: 'ok',
      amount_usd: 50,
      credit_transaction_id: 'test-tx',
    });

    const result = await refreshContributorChampionCredits();

    expect(result.processed).toBe(1);
    expect(result.granted).toBe(1);
    expect(result.skippedNoUser).toBe(0);
    expect(result.errored).toBe(0);

    expect(mockedGrantCredit).toHaveBeenCalledWith(
      expect.objectContaining({ id: user.id }),
      expect.objectContaining({
        credit_category: 'contributor-champion-credits',
        amount_usd: 50,
      })
    );

    const membership = await db.query.contributor_champion_memberships.findFirst({
      where: eq(contributor_champion_memberships.contributor_id, contributorId),
    });
    expect(membership?.credits_last_granted_at).not.toBeNull();
  });

  it('refreshContributorChampionCredits skips members whose credits were granted less than 30 days ago', async () => {
    const user = await insertTestUser({ google_user_email: 'recent-credit@example.com' });
    const contributorId = await insertContributor({
      login: 'recent-credit-contributor',
      allTimeContributions: 10,
    });
    await insertEvent({
      contributorId,
      prNumber: 10_100,
      mergedAt: daysAgo(10),
      login: 'recent-credit-contributor',
      email: 'recent-credit@example.com',
    });

    await db.insert(contributor_champion_memberships).values({
      contributor_id: contributorId,
      enrolled_tier: 'ambassador',
      enrolled_at: daysAgo(60),
      credit_amount_microdollars: 50_000_000,
      linked_kilo_user_id: user.id,
      credits_last_granted_at: daysAgo(15),
    });

    mockedGrantCredit.mockResolvedValue({
      success: true,
      message: 'ok',
      amount_usd: 50,
      credit_transaction_id: 'test-tx',
    });

    const result = await refreshContributorChampionCredits();

    expect(result.processed).toBe(0);
    expect(result.granted).toBe(0);
    expect(mockedGrantCredit).not.toHaveBeenCalled();
  });

  it('manualEnrollContributor creates contributor and membership, grants credits when linked', async () => {
    const user = await insertTestUser({ google_user_email: 'manual@example.com' });

    mockedGrantCredit.mockResolvedValue({
      success: true,
      message: 'ok',
      amount_usd: 50,
      credit_transaction_id: 'test-tx',
    });

    const result = await manualEnrollContributor({
      email: 'manual@example.com',
      githubLogin: 'manual-user',
      tier: 'ambassador',
      kiloUserId: user.id,
    });

    expect(result.enrolledTier).toBe('ambassador');
    expect(result.creditAmountUsd).toBe(50);
    expect(result.creditGranted).toBe(true);

    expect(mockedGrantCredit).toHaveBeenCalledWith(
      expect.objectContaining({ id: user.id }),
      expect.objectContaining({
        credit_category: 'contributor-champion-credits',
        amount_usd: 50,
      })
    );

    const contributor = await db.query.contributor_champion_contributors.findFirst({
      where: eq(contributor_champion_contributors.github_login, 'manual-user'),
    });
    expect(contributor).toBeTruthy();
    expect(contributor?.manual_email).toBe('manual@example.com');
  });

  it('manualEnrollContributor preserves credits_last_granted_at on re-enrollment', async () => {
    const user = await insertTestUser({ google_user_email: 'remanual@example.com' });

    mockedGrantCredit.mockResolvedValue({
      success: true,
      message: 'ok',
      amount_usd: 50,
      credit_transaction_id: 'test-tx',
    });

    await manualEnrollContributor({
      email: 'remanual@example.com',
      githubLogin: 'remanual-user',
      tier: 'contributor',
      kiloUserId: user.id,
    });

    const contributor = await db.query.contributor_champion_contributors.findFirst({
      where: eq(contributor_champion_contributors.github_login, 'remanual-user'),
    });
    const grantedAt = daysAgo(10);
    await db
      .update(contributor_champion_memberships)
      .set({ credits_last_granted_at: grantedAt })
      .where(eq(contributor_champion_memberships.contributor_id, contributor!.id));

    // Re-enroll as contributor ($0 credits, no grant) so credits_last_granted_at
    // is only affected by the onConflictDoUpdate upsert, not by a new credit grant.
    await manualEnrollContributor({
      email: 'remanual@example.com',
      githubLogin: 'remanual-user',
      tier: 'contributor',
      kiloUserId: user.id,
    });

    const membership = await db.query.contributor_champion_memberships.findFirst({
      where: eq(contributor_champion_memberships.contributor_id, contributor!.id),
    });
    expect(membership?.enrolled_tier).toBe('contributor');
    // Verify credits_last_granted_at was preserved (not reset to null) after re-enrollment.
    expect(membership?.credits_last_granted_at).not.toBeNull();
  });

  it('searchKiloUsersByEmail returns matching users', async () => {
    await insertTestUser({ google_user_email: 'findme@example.com', google_user_name: 'Find Me' });
    await insertTestUser({
      google_user_email: 'other@example.com',
      google_user_name: 'Other User',
    });

    const results = await searchKiloUsersByEmail('findme');
    expect(results).toHaveLength(1);
    expect(results[0]?.email).toBe('findme@example.com');
  });

  it('searchKiloUsersByEmail returns empty for short queries', async () => {
    const results = await searchKiloUsersByEmail('a');
    expect(results).toHaveLength(0);
  });
});
