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
  cloud_agent_code_reviews,
  kilocode_users,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { listDispatchableCodeReviewOwnerCandidates } from '../db/code-reviews';
import { cronPendingCodeReviewUpdatedAfterSql } from './dispatch-constants';
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

  it('bounds cron pending discovery by updated_at while still recovering stale queued work', async () => {
    const oldIdleTimestamp = minutesAgo(180);
    const oldCreatedRecentlyUpdatedCreatedAt = minutesAgo(240);
    const oldCreatedRecentlyUpdatedUpdatedAt = minutesAgo(30);
    const recentPendingTimestamp = minutesAgo(15);
    const oldQueuedCreatedAt = minutesAgo(360);
    const staleQueuedUpdatedAt = minutesAgo(10);

    await db.insert(cloud_agent_code_reviews).values([
      // First user: only an idle pending review older than the cron cutoff
      reviewValues({
        owner: { type: 'user', id: firstUser.id },
        status: 'pending',
        createdAt: oldIdleTimestamp,
        updatedAt: oldIdleTimestamp,
      }),
      // Second user: old-created pending whose updated_at was refreshed
      // recently (e.g. by a manual retry) — should still be reachable.
      reviewValues({
        owner: { type: 'user', id: secondUser.id },
        status: 'pending',
        createdAt: oldCreatedRecentlyUpdatedCreatedAt,
        updatedAt: oldCreatedRecentlyUpdatedUpdatedAt,
      }),
      // First org: a recently created pending review.
      reviewValues({
        owner: { type: 'org', id: firstOrganizationId },
        status: 'pending',
        createdAt: recentPendingTimestamp,
        updatedAt: recentPendingTimestamp,
      }),
      // Second org: stale queued recovery — must remain visible regardless of age.
      reviewValues({
        owner: { type: 'org', id: secondOrganizationId },
        status: 'queued',
        createdAt: oldQueuedCreatedAt,
        updatedAt: staleQueuedUpdatedAt,
      }),
    ]);

    const result = await listDispatchableCodeReviewOwnerCandidates({
      limit: 10,
      pendingUpdatedAfter: cronPendingCodeReviewUpdatedAfterSql(),
    });

    expect(result).toEqual({
      owners: [
        { type: 'org', id: secondOrganizationId },
        { type: 'user', id: secondUser.id },
        { type: 'org', id: firstOrganizationId },
      ],
      hasMore: false,
    });
  });

  it('drains owners with recently active pending work and skips idle pending owners', async () => {
    await db.insert(cloud_agent_code_reviews).values([
      // Idle pending older than the cron cutoff — owner should be skipped entirely.
      reviewValues({
        owner: { type: 'user', id: firstUser.id },
        status: 'pending',
        createdAt: minutesAgo(180),
        updatedAt: minutesAgo(180),
      }),
      // Recently active pending — owner should be drained.
      reviewValues({
        owner: { type: 'user', id: secondUser.id },
        status: 'pending',
        createdAt: minutesAgo(30),
        updatedAt: minutesAgo(30),
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
      hasMoreCandidateOwners: false,
    });
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledTimes(1);
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledWith(
      {
        type: 'user',
        id: secondUser.id,
        userId: secondUser.id,
      },
      expect.objectContaining({ pendingUpdatedAfter: expect.anything() })
    );
  });

  it('summarizes dispatch, recovered bot owners, no-op owners, and isolated owner failures', async () => {
    const waitingTimestamp = minutesAgo(10);
    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({
        owner: { type: 'user', id: firstUser.id },
        status: 'pending',
        createdAt: waitingTimestamp,
      }),
      reviewValues({
        owner: { type: 'user', id: secondUser.id },
        status: 'pending',
        createdAt: minutesAgo(9),
      }),
      reviewValues({
        owner: { type: 'org', id: firstOrganizationId },
        status: 'pending',
        createdAt: minutesAgo(8),
      }),
      reviewValues({
        owner: { type: 'org', id: secondOrganizationId },
        status: 'pending',
        createdAt: minutesAgo(7),
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
      hasMoreCandidateOwners: false,
    });
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledTimes(4);
    expect(mockEnsureBotUserForOrg).toHaveBeenCalledWith(firstOrganizationId, 'code-review');
    expect(mockEnsureBotUserForOrg).toHaveBeenCalledWith(secondOrganizationId, 'code-review');
  });
});
