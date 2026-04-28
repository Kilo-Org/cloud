const mockDispatchReview = jest.fn();

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    dispatchReview: (...args: unknown[]) => mockDispatchReview(...args),
  },
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { cloud_agent_code_reviews, kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { tryDispatchPendingReviews } from './dispatch-pending-reviews';

const REPO = `test-org/dispatch-pending-${Date.now()}`;

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

describe('tryDispatchPendingReviews', () => {
  let testUser: User;
  let reviewSequence = 0;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.owned_by_user_id, testUser.id));
    mockDispatchReview.mockClear();
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  function reviewValues({
    status,
    createdAt,
    updatedAt,
    startedAt = null,
  }: {
    status: 'queued' | 'running';
    createdAt: string;
    updatedAt: string;
    startedAt?: string | null;
  }) {
    const sequence = reviewSequence++;

    return {
      owned_by_user_id: testUser.id,
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

  it('does not count stale running reviews against owner capacity', async () => {
    const recentTimestamp = minutesAgo(1);
    const staleRunningTimestamp = minutesAgo(91);

    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({
        status: 'running',
        createdAt: recentTimestamp,
        updatedAt: recentTimestamp,
        startedAt: recentTimestamp,
      }),
      ...Array.from({ length: 19 }, () =>
        reviewValues({
          status: 'queued',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      ),
      reviewValues({
        status: 'running',
        createdAt: staleRunningTimestamp,
        updatedAt: staleRunningTimestamp,
        startedAt: staleRunningTimestamp,
      }),
    ]);

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
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

    await db.insert(cloud_agent_code_reviews).values([
      ...Array.from({ length: 20 }, () =>
        reviewValues({
          status: 'running',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
          startedAt: recentTimestamp,
        })
      ),
      reviewValues({
        status: 'queued',
        createdAt: staleQueuedTimestamp,
        updatedAt: staleQueuedTimestamp,
      }),
    ]);

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
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
