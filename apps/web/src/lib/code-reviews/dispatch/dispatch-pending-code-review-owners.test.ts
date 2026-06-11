const mockTryDispatchPendingReviews = jest.fn();
const mockEnsureBotUserForOrg = jest.fn();

jest.mock('./dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: (...args: unknown[]) => mockTryDispatchPendingReviews(...args),
}));

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  ensureBotUserForOrg: (...args: unknown[]) => mockEnsureBotUserForOrg(...args),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  DISPATCH_EXPIRED_CODE_REVIEW_ERROR_MESSAGE,
  listDispatchableCodeReviewOwnerCandidates,
} from '../db/code-reviews';
import { cronPendingCodeReviewCreatedAtWindowSql } from './dispatch-constants';
import { dispatchPendingCodeReviewOwners } from './dispatch-pending-code-review-owners';

const REPO = `test-org/dispatch-owner-drain-${Date.now()}`;

type ReviewOwner = { type: 'user'; id: string } | { type: 'org'; id: string };

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

describe('dispatch pending code review owners', () => {
  let firstUser: User;
  let secondUser: User;
  let firstOrganizationId = '';
  let secondOrganizationId = '';
  let reviewSequence = 0;

  beforeAll(async () => {
    firstUser = await insertTestUser();
    secondUser = await insertTestUser();
    const [firstOrganization, secondOrganization] = await db
      .insert(organizations)
      .values([
        { name: `Dispatch Owner Drain A ${Date.now()}` },
        { name: `Dispatch Owner Drain B ${Date.now()}` },
      ])
      .returning({ id: organizations.id });

    if (!firstOrganization || !secondOrganization) {
      throw new Error('Expected owner-drain test organizations to be inserted');
    }

    firstOrganizationId = firstOrganization.id;
    secondOrganizationId = secondOrganization.id;
  });

  beforeEach(() => {
    mockTryDispatchPendingReviews.mockReset();
    mockEnsureBotUserForOrg.mockReset();
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, firstOrganizationId));
    await db.delete(organizations).where(eq(organizations.id, secondOrganizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, firstUser.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, secondUser.id));
  });

  function reviewValues(params: {
    owner: ReviewOwner;
    status: 'pending' | 'queued' | 'running' | 'completed';
    createdAt: string;
    updatedAt?: string;
    startedAt?: string | null;
  }) {
    const sequence = reviewSequence++;
    return {
      owned_by_user_id: params.owner.type === 'user' ? params.owner.id : null,
      owned_by_organization_id: params.owner.type === 'org' ? params.owner.id : null,
      repo_full_name: REPO,
      pr_number: sequence + 1,
      pr_url: `https://github.com/${REPO}/pull/${sequence + 1}`,
      pr_title: `Owner drain PR ${sequence + 1}`,
      pr_author: 'octocat',
      base_ref: 'main',
      head_ref: `feature/owner-drain-${sequence}`,
      head_sha: `owner-drain-sha-${sequence}`,
      status: params.status,
      created_at: params.createdAt,
      updated_at: params.updatedAt ?? params.createdAt,
      started_at: params.startedAt ?? null,
    };
  }

  async function getReview(reviewId: string) {
    const review = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, reviewId),
    });

    if (!review) {
      throw new Error(`Expected review ${reviewId} to exist`);
    }

    return review;
  }

  async function listAttempts(reviewId: string) {
    return await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, reviewId));
  }

  it('discovers unique eligible owners oldest-first with truncation and capacity prefiltering', async () => {
    const oldestBlockedTimestamp = minutesAgo(40);
    const oldestEligibleTimestamp = minutesAgo(30);
    const organizationTimestamp = minutesAgo(20);
    const freshTimestamp = minutesAgo(1);
    const staleQueuedTimestamp = minutesAgo(6);

    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({
        owner: { type: 'user', id: secondUser.id },
        status: 'pending',
        createdAt: oldestBlockedTimestamp,
      }),
      reviewValues({
        owner: { type: 'user', id: secondUser.id },
        status: 'queued',
        createdAt: freshTimestamp,
        updatedAt: freshTimestamp,
      }),
      reviewValues({
        owner: { type: 'user', id: firstUser.id },
        status: 'pending',
        createdAt: oldestEligibleTimestamp,
      }),
      reviewValues({
        owner: { type: 'user', id: firstUser.id },
        status: 'pending',
        createdAt: minutesAgo(10),
      }),
      reviewValues({
        owner: { type: 'org', id: firstOrganizationId },
        status: 'queued',
        createdAt: organizationTimestamp,
        updatedAt: staleQueuedTimestamp,
      }),
      reviewValues({
        owner: { type: 'org', id: secondOrganizationId },
        status: 'running',
        createdAt: freshTimestamp,
        updatedAt: freshTimestamp,
        startedAt: freshTimestamp,
      }),
      reviewValues({
        owner: { type: 'org', id: secondOrganizationId },
        status: 'completed',
        createdAt: minutesAgo(5),
      }),
    ]);

    const firstPage = await listDispatchableCodeReviewOwnerCandidates({ limit: 1 });
    const fullPage = await listDispatchableCodeReviewOwnerCandidates({ limit: 10 });

    expect(firstPage).toEqual({
      owners: [{ type: 'user', id: firstUser.id }],
      hasMore: true,
    });
    expect(fullPage).toEqual({
      owners: [
        { type: 'user', id: firstUser.id },
        { type: 'org', id: firstOrganizationId },
      ],
      hasMore: false,
    });
  });

  it('bounds cron pending discovery by created_at while still recovering stale queued work', async () => {
    const tooRecentPendingTimestamp = minutesAgo(30);
    const eligiblePendingTimestamp = minutesAgo(65);
    const tooOldPendingTimestamp = minutesAgo(90);
    const recentlyUpdatedAt = minutesAgo(5);
    const oldQueuedCreatedAt = minutesAgo(360);
    const staleQueuedUpdatedAt = minutesAgo(10);

    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({
        owner: { type: 'user', id: firstUser.id },
        status: 'pending',
        createdAt: tooRecentPendingTimestamp,
        updatedAt: tooRecentPendingTimestamp,
      }),
      reviewValues({
        owner: { type: 'user', id: secondUser.id },
        status: 'pending',
        createdAt: eligiblePendingTimestamp,
        updatedAt: recentlyUpdatedAt,
      }),
      reviewValues({
        owner: { type: 'org', id: firstOrganizationId },
        status: 'pending',
        createdAt: tooOldPendingTimestamp,
        updatedAt: recentlyUpdatedAt,
      }),
      reviewValues({
        owner: { type: 'org', id: secondOrganizationId },
        status: 'queued',
        createdAt: oldQueuedCreatedAt,
        updatedAt: staleQueuedUpdatedAt,
      }),
    ]);

    const result = await listDispatchableCodeReviewOwnerCandidates({
      limit: 10,
      pendingCreatedAtWindow: cronPendingCodeReviewCreatedAtWindowSql(),
    });

    expect(result).toEqual({
      owners: [
        { type: 'org', id: secondOrganizationId },
        { type: 'user', id: secondUser.id },
      ],
      hasMore: false,
    });
  });

  it('drains owners with pending work inside the cron window and skips outside-window pending owners', async () => {
    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({
        owner: { type: 'user', id: firstUser.id },
        status: 'pending',
        createdAt: minutesAgo(90),
        updatedAt: minutesAgo(5),
      }),
      reviewValues({
        owner: { type: 'user', id: secondUser.id },
        status: 'pending',
        createdAt: minutesAgo(65),
        updatedAt: minutesAgo(5),
      }),
    ]);

    mockTryDispatchPendingReviews.mockResolvedValue({
      dispatched: 1,
      notDispatched: 0,
      activeCount: 1,
    });

    const summary = await dispatchPendingCodeReviewOwners();

    expect(summary).toEqual({
      ownersConsidered: 1,
      ownersProcessed: 1,
      ownersWithNoNewDispatch: 0,
      ownersSkippedMissingBotUsers: 0,
      coordinatorFailures: 0,
      reviewsDispatched: 1,
      staleReviewsCancelled: 1,
      staleAttemptsCancelled: 0,
      hasMoreCandidateOwners: false,
    });
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledTimes(1);
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledWith(
      {
        type: 'user',
        id: secondUser.id,
        userId: secondUser.id,
      },
      expect.objectContaining({ pendingCreatedAtWindow: expect.anything() })
    );
  });

  it('cancels expired pending and running reviews before draining cron-window owners', async () => {
    const expiredTimestamp = minutesAgo(76);
    const oldParentTimestamp = minutesAgo(120);
    const freshAttemptTimestamp = minutesAgo(10);
    const dispatchWindowTimestamp = minutesAgo(65);

    const [stalePendingReview, staleRunningReview, retryParentReview, dispatchWindowReview] =
      await db
        .insert(cloud_agent_code_reviews)
        .values([
          reviewValues({
            owner: { type: 'user', id: firstUser.id },
            status: 'pending',
            createdAt: expiredTimestamp,
            updatedAt: expiredTimestamp,
          }),
          reviewValues({
            owner: { type: 'user', id: firstUser.id },
            status: 'running',
            createdAt: expiredTimestamp,
            updatedAt: expiredTimestamp,
            startedAt: expiredTimestamp,
          }),
          reviewValues({
            owner: { type: 'user', id: firstUser.id },
            status: 'running',
            createdAt: oldParentTimestamp,
            updatedAt: oldParentTimestamp,
            startedAt: oldParentTimestamp,
          }),
          reviewValues({
            owner: { type: 'user', id: secondUser.id },
            status: 'pending',
            createdAt: dispatchWindowTimestamp,
            updatedAt: dispatchWindowTimestamp,
          }),
        ])
        .returning({ id: cloud_agent_code_reviews.id });

    if (!stalePendingReview || !staleRunningReview || !retryParentReview || !dispatchWindowReview) {
      throw new Error('Expected stale cancellation test reviews to be inserted');
    }

    await db.insert(cloud_agent_code_review_attempts).values({
      code_review_id: staleRunningReview.id,
      attempt_number: 1,
      status: 'running',
      started_at: expiredTimestamp,
      created_at: expiredTimestamp,
      updated_at: expiredTimestamp,
    });

    const [failedAttempt] = await db
      .insert(cloud_agent_code_review_attempts)
      .values({
        code_review_id: retryParentReview.id,
        attempt_number: 1,
        status: 'failed',
        terminal_reason: 'sandbox_error',
        error_message: 'Sandbox failed before retry',
        completed_at: expiredTimestamp,
        created_at: expiredTimestamp,
        updated_at: expiredTimestamp,
      })
      .returning({ id: cloud_agent_code_review_attempts.id });

    if (!failedAttempt) {
      throw new Error('Expected failed retry source attempt to be inserted');
    }

    await db.insert(cloud_agent_code_review_attempts).values({
      code_review_id: retryParentReview.id,
      attempt_number: 2,
      retry_of_attempt_id: failedAttempt.id,
      retry_reason: 'infra_failure',
      status: 'pending',
      created_at: freshAttemptTimestamp,
      updated_at: freshAttemptTimestamp,
    });

    mockTryDispatchPendingReviews.mockResolvedValue({
      dispatched: 1,
      notDispatched: 0,
      activeCount: 1,
    });

    const summary = await dispatchPendingCodeReviewOwners();

    expect(summary).toEqual({
      ownersConsidered: 1,
      ownersProcessed: 1,
      ownersWithNoNewDispatch: 0,
      ownersSkippedMissingBotUsers: 0,
      coordinatorFailures: 0,
      reviewsDispatched: 1,
      staleReviewsCancelled: 2,
      staleAttemptsCancelled: 1,
      hasMoreCandidateOwners: false,
    });
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledTimes(1);
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledWith(
      {
        type: 'user',
        id: secondUser.id,
        userId: secondUser.id,
      },
      expect.objectContaining({ pendingCreatedAtWindow: expect.anything() })
    );

    const storedStalePendingReview = await getReview(stalePendingReview.id);
    const storedStaleRunningReview = await getReview(staleRunningReview.id);
    const storedRetryParentReview = await getReview(retryParentReview.id);
    const storedDispatchWindowReview = await getReview(dispatchWindowReview.id);
    const staleRunningAttempts = await listAttempts(staleRunningReview.id);
    const retryParentAttempts = await listAttempts(retryParentReview.id);

    expect(storedStalePendingReview).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        terminal_reason: 'dispatch_expired',
        error_message: DISPATCH_EXPIRED_CODE_REVIEW_ERROR_MESSAGE,
      })
    );
    expect(storedStalePendingReview.completed_at).toEqual(expect.any(String));
    expect(storedStaleRunningReview).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        terminal_reason: 'dispatch_expired',
        error_message: DISPATCH_EXPIRED_CODE_REVIEW_ERROR_MESSAGE,
      })
    );
    expect(storedStaleRunningReview.completed_at).toEqual(expect.any(String));
    expect(staleRunningAttempts).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        terminal_reason: 'dispatch_expired',
        error_message: DISPATCH_EXPIRED_CODE_REVIEW_ERROR_MESSAGE,
        completed_at: expect.any(String),
      }),
    ]);
    expect(storedRetryParentReview.status).toBe('running');
    expect(storedRetryParentReview.terminal_reason).toBeNull();
    expect(retryParentAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'failed', terminal_reason: 'sandbox_error' }),
        expect.objectContaining({ status: 'pending', retry_reason: 'infra_failure' }),
      ])
    );
    expect(storedDispatchWindowReview.status).toBe('pending');
  });

  it('summarizes dispatch, recovered bot owners, no-op owners, and isolated owner failures', async () => {
    const waitingTimestamp = minutesAgo(65);
    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({
        owner: { type: 'user', id: firstUser.id },
        status: 'pending',
        createdAt: waitingTimestamp,
      }),
      reviewValues({
        owner: { type: 'user', id: secondUser.id },
        status: 'pending',
        createdAt: minutesAgo(66),
      }),
      reviewValues({
        owner: { type: 'org', id: firstOrganizationId },
        status: 'pending',
        createdAt: minutesAgo(67),
      }),
      reviewValues({
        owner: { type: 'org', id: secondOrganizationId },
        status: 'pending',
        createdAt: minutesAgo(68),
      }),
    ]);

    mockEnsureBotUserForOrg.mockResolvedValue({ id: 'code-review-bot-user' });
    mockTryDispatchPendingReviews.mockImplementation(async (owner: { id: string }) => {
      if (owner.id === secondUser.id) {
        throw new Error('owner dispatch failed');
      }
      return {
        dispatched: owner.id === firstUser.id ? 2 : 0,
        notDispatched: 0,
        activeCount: 0,
      };
    });

    const summary = await dispatchPendingCodeReviewOwners();

    expect(summary).toEqual({
      ownersConsidered: 4,
      ownersProcessed: 3,
      ownersWithNoNewDispatch: 2,
      ownersSkippedMissingBotUsers: 0,
      coordinatorFailures: 1,
      reviewsDispatched: 2,
      staleReviewsCancelled: 0,
      staleAttemptsCancelled: 0,
      hasMoreCandidateOwners: false,
    });
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledTimes(4);
    expect(mockEnsureBotUserForOrg).toHaveBeenCalledWith(firstOrganizationId, 'code-review');
    expect(mockEnsureBotUserForOrg).toHaveBeenCalledWith(secondOrganizationId, 'code-review');
  });
});
