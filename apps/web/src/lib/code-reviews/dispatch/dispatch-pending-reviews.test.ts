const mockDispatchReview = jest.fn();
const mockGetAgentConfigForOwner = jest.fn();
const mockPrepareReviewPayload = jest.fn();

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    dispatchReview: (...args: unknown[]) => mockDispatchReview(...args),
  },
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (...args: unknown[]) => mockGetAgentConfigForOwner(...args),
}));

jest.mock('@/lib/code-reviews/triggers/prepare-review-payload', () => ({
  prepareReviewPayload: (...args: unknown[]) => mockPrepareReviewPayload(...args),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cloud_agent_code_reviews,
  kilocode_users,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { tryDispatchPendingReviews } from './dispatch-pending-reviews';

const REPO = `test-org/dispatch-pending-${Date.now()}`;
const FUNDED_BALANCE_MICRODOLLARS = 5_000_001;
const DEFAULT_TIER_BALANCE_MICRODOLLARS = 5_000_000;

type ReviewStatus = 'pending' | 'queued' | 'running';
type ReviewOwner = { type: 'user'; id: string } | { type: 'org'; id: string };

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

describe('tryDispatchPendingReviews', () => {
  let testUser: User;
  let testOrganizationId: string;
  let reviewSequence = 0;

  beforeAll(async () => {
    testUser = await insertTestUser();
    const [organization] = await db
      .insert(organizations)
      .values({ name: `Dispatch Pending Reviews ${Date.now()}` })
      .returning({ id: organizations.id });
    testOrganizationId = organization.id;
  });

  beforeEach(() => {
    mockDispatchReview.mockResolvedValue(undefined);
    mockGetAgentConfigForOwner.mockResolvedValue({ id: 'test-agent-config', config: {} });
    mockPrepareReviewPayload.mockImplementation((params: { reviewId: string }) => ({
      reviewId: params.reviewId,
    }));
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
    mockDispatchReview.mockReset();
    mockGetAgentConfigForOwner.mockReset();
    mockPrepareReviewPayload.mockReset();
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, testOrganizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function setTestUserBalance(totalMicrodollarsAcquired: number, microdollarsUsed = 0) {
    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: totalMicrodollarsAcquired,
        microdollars_used: microdollarsUsed,
      })
      .where(eq(kilocode_users.id, testUser.id));
  }

  function reviewValues({
    owner,
    status,
    createdAt,
    updatedAt,
    startedAt = null,
  }: {
    owner: ReviewOwner;
    status: ReviewStatus;
    createdAt: string;
    updatedAt: string;
    startedAt?: string | null;
  }) {
    const sequence = reviewSequence++;

    return {
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'org' ? owner.id : null,
      repo_full_name: REPO,
      pr_number: sequence + 1,
      pr_url: `https://github.com/${REPO}/pull/${sequence + 1}`,
      pr_title: `Test PR ${sequence + 1}`,
      pr_author: 'octocat',
      base_ref: 'main',
      head_ref: `feature/test-${sequence}`,
      head_sha: `sha-${sequence}`,
      status,
      started_at: startedAt,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  }

  it('keeps organization concurrency at 20 reviews', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;

    await db.insert(cloud_agent_code_reviews).values([
      ...Array.from({ length: 18 }, () =>
        reviewValues({
          owner,
          status: 'running',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
          startedAt: recentTimestamp,
        })
      ),
      ...Array.from({ length: 5 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      ),
    ]);

    const result = await tryDispatchPendingReviews({
      type: 'org',
      id: testOrganizationId,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 2,
      pending: 0,
      activeCount: 20,
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(2);
    expect(mockPrepareReviewPayload).toHaveBeenCalledTimes(2);
  });

  it('dispatches up to 3 personal reviews when the user has more than $5 in credits', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(FUNDED_BALANCE_MICRODOLLARS);

    await db.insert(cloud_agent_code_reviews).values(
      Array.from({ length: 5 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
    );

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 3,
      pending: 0,
      activeCount: 3,
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(3);
  });

  it('dispatches one additional funded personal review when two are already active', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(FUNDED_BALANCE_MICRODOLLARS);

    await db.insert(cloud_agent_code_reviews).values([
      ...Array.from({ length: 2 }, () =>
        reviewValues({
          owner,
          status: 'running',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
          startedAt: recentTimestamp,
        })
      ),
      ...Array.from({ length: 5 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      ),
    ]);

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 1,
      pending: 0,
      activeCount: 3,
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch funded personal reviews when three are already active', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(FUNDED_BALANCE_MICRODOLLARS);

    await db.insert(cloud_agent_code_reviews).values([
      ...Array.from({ length: 3 }, () =>
        reviewValues({
          owner,
          status: 'running',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
          startedAt: recentTimestamp,
        })
      ),
      ...Array.from({ length: 2 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      ),
    ]);

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 0,
      pending: 0,
      activeCount: 3,
    });
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('dispatches only 1 personal review when the user has exactly $5 in credits', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);

    await db.insert(cloud_agent_code_reviews).values(
      Array.from({ length: 5 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
    );

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 1,
      pending: 0,
      activeCount: 1,
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('dispatches only 1 personal review when the user has less than $5 in credits', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS - 1);

    await db.insert(cloud_agent_code_reviews).values(
      Array.from({ length: 5 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
    );

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 1,
      pending: 0,
      activeCount: 1,
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('does not count stale running reviews against owner capacity', async () => {
    const recentTimestamp = minutesAgo(1);
    const staleRunningTimestamp = minutesAgo(91);
    const owner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;

    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({
        owner,
        status: 'running',
        createdAt: recentTimestamp,
        updatedAt: recentTimestamp,
        startedAt: recentTimestamp,
      }),
      ...Array.from({ length: 19 }, () =>
        reviewValues({
          owner,
          status: 'queued',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      ),
      reviewValues({
        owner,
        status: 'running',
        createdAt: staleRunningTimestamp,
        updatedAt: staleRunningTimestamp,
        startedAt: staleRunningTimestamp,
      }),
    ]);

    const result = await tryDispatchPendingReviews({
      type: 'org',
      id: testOrganizationId,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 0,
      pending: 0,
      activeCount: 20,
    });
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('does not count stale queued reviews against owner capacity', async () => {
    const recentTimestamp = minutesAgo(1);
    const staleQueuedTimestamp = minutesAgo(6);
    const owner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;

    await db.insert(cloud_agent_code_reviews).values([
      ...Array.from({ length: 20 }, () =>
        reviewValues({
          owner,
          status: 'running',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
          startedAt: recentTimestamp,
        })
      ),
      reviewValues({
        owner,
        status: 'queued',
        createdAt: staleQueuedTimestamp,
        updatedAt: staleQueuedTimestamp,
      }),
    ]);

    const result = await tryDispatchPendingReviews({
      type: 'org',
      id: testOrganizationId,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 0,
      pending: 0,
      activeCount: 20,
    });
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });
});
