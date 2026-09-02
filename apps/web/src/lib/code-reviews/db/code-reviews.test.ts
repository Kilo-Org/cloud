import { db } from '@/lib/drizzle';
import {
  agent_configs,
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
  operation_ledgers,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import type { CodeReviewCouncilResult, ManualCodeReviewConfig } from '@kilocode/db/schema-types';
import {
  admitCodeReviewAttemptForDispatch,
  admitCodeReviewLedgerRow,
  pinCodeReviewAttemptReviewer,
  bitbucketCodeReviewerLifecycleLockKey,
  cancelCodeReview,
  prepareCodeReviewCancellation,
  cancelActiveCodeReviewsById,
  cancelActiveCodeReviewsForIntegration,
  cancelSupersededReviewsForPR,
  createCodeReview,
  createCodeReviewIfAbsentInTransaction,
  createCodeReviewAttempt,
  disableBitbucketCodeReviewerForIntegration,
  createInfraRetryAttemptIfMissing,
  ensureCurrentCodeReviewAttemptFromReview,
  findActiveReviewsForPR,
  findExistingReview,
  getCodeReviewAttemptForReview,
  getCodeReviewAttemptMetadataForReview,
  getCodeReviewCouncilResult,
  getSessionUsageFromBilling,
  listCodeReviewAttempts,
  listCodeReviews,
  updateCodeReviewAttemptForCallback,
  findPreviousCompletedReview,
  updateCodeReviewStatus,
  updateCodeReviewStatusIfNonTerminal,
  resetCodeReviewForRetry,
  failReservedQueuedReview,
  updatePreviousReviewSummary,
} from './code-reviews';

const REPO = `test-org/session-continuation-${Date.now()}`;

describe('review identity', () => {
  let firstUser: User;
  let secondUser: User;
  let firstIntegrationId: string;
  let secondIntegrationId: string;
  let alternateFirstUserIntegrationId: string;
  let firstGitLabIntegrationId: string;
  let secondGitLabIntegrationId: string;
  let bitbucketIntegrationId: string;
  let organizationId: string;
  let organizationIntegrationId: string;
  const createdReviewIds: string[] = [];

  beforeAll(async () => {
    [firstUser, secondUser] = await Promise.all([insertTestUser(), insertTestUser()]);
    const integrations = await db
      .insert(platform_integrations)
      .values(
        [firstUser, secondUser, firstUser].map((user, index) => ({
          owned_by_user_id: user.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: `review-identity-${Date.now()}-${index}`,
          platform_account_id: `review-identity-${index}`,
          platform_account_login: `review-identity-${index}`,
          repository_access: 'all',
          integration_status: 'active',
        }))
      )
      .returning({ id: platform_integrations.id });
    if (!integrations[0] || !integrations[1] || !integrations[2]) {
      throw new Error('Expected review identity integrations');
    }
    firstIntegrationId = integrations[0].id;
    secondIntegrationId = integrations[1].id;
    alternateFirstUserIntegrationId = integrations[2].id;
    const gitLabIntegrations = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_user_id: firstUser.id,
          platform: 'gitlab',
          integration_type: 'oauth',
          platform_installation_id: `review-identity-gitlab-a-${Date.now()}`,
          platform_account_id: 'review-identity-gitlab-a',
          platform_account_login: 'review-identity-gitlab-a',
          repository_access: 'all',
          integration_status: 'active',
          metadata: { gitlab_instance_url: 'https://gitlab-a.example.com' },
        },
        {
          owned_by_user_id: firstUser.id,
          platform: 'gitlab',
          integration_type: 'oauth',
          platform_installation_id: `review-identity-gitlab-b-${Date.now()}`,
          platform_account_id: 'review-identity-gitlab-b',
          platform_account_login: 'review-identity-gitlab-b',
          repository_access: 'all',
          integration_status: 'active',
          metadata: { gitlab_instance_url: 'https://gitlab-b.example.com' },
        },
      ])
      .returning({ id: platform_integrations.id });
    if (!gitLabIntegrations[0] || !gitLabIntegrations[1]) {
      throw new Error('Expected review identity GitLab integrations');
    }
    firstGitLabIntegrationId = gitLabIntegrations[0].id;
    secondGitLabIntegrationId = gitLabIntegrations[1].id;
    const [bitbucketIntegration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: firstUser.id,
        platform: 'bitbucket',
        integration_type: 'oauth',
        platform_installation_id: `review-identity-bitbucket-${Date.now()}`,
        platform_account_id: 'review-identity-bitbucket',
        platform_account_login: 'review-identity-bitbucket',
        repository_access: 'selected',
        integration_status: 'active',
      })
      .returning({ id: platform_integrations.id });
    if (!bitbucketIntegration) {
      throw new Error('Expected Bitbucket review identity integration');
    }
    bitbucketIntegrationId = bitbucketIntegration.id;

    const [organization] = await db
      .insert(organizations)
      .values({ name: `Review identity ${Date.now()}` })
      .returning({ id: organizations.id });
    if (!organization) {
      throw new Error('Expected review identity organization');
    }
    organizationId = organization.id;
    const [organizationIntegration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: `review-identity-org-${Date.now()}`,
        platform_account_id: 'review-identity-org',
        platform_account_login: 'review-identity-org',
        repository_access: 'all',
        integration_status: 'active',
      })
      .returning({ id: platform_integrations.id });
    if (!organizationIntegration) {
      throw new Error('Expected organization review identity integration');
    }
    organizationIntegrationId = organizationIntegration.id;
  });

  afterAll(async () => {
    if (createdReviewIds.length > 0) {
      await db
        .delete(cloud_agent_code_reviews)
        .where(inArray(cloud_agent_code_reviews.id, createdReviewIds));
    }
    await db
      .delete(platform_integrations)
      .where(
        inArray(platform_integrations.id, [
          firstIntegrationId,
          secondIntegrationId,
          alternateFirstUserIntegrationId,
          firstGitLabIntegrationId,
          secondGitLabIntegrationId,
          bitbucketIntegrationId,
          organizationIntegrationId,
        ])
      );
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db
      .delete(kilocode_users)
      .where(inArray(kilocode_users.id, [firstUser.id, secondUser.id]));
  });

  it('keeps active review uniqueness scoped to the same integration, repo, and PR', async () => {
    const sharedRepo = `${REPO}-shared-repository`;
    const createForIntegration = async (user: User, platformIntegrationId: string) => {
      const id = await createCodeReview({
        owner: { type: 'user', id: user.id, userId: user.id },
        platformIntegrationId,
        repoFullName: sharedRepo,
        prNumber: 17,
        prUrl: `https://github.com/${sharedRepo}/pull/17`,
        prTitle: 'shared review identity',
        prAuthor: 'octocat',
        baseRef: 'main',
        headRef: 'feature/shared',
        headSha: 'shared-head-sha',
        platform: 'github',
      });
      createdReviewIds.push(id);
      return id;
    };

    const firstReviewId = await createForIntegration(firstUser, firstIntegrationId);
    await expect(createForIntegration(firstUser, firstIntegrationId)).rejects.toThrow();
    const secondReviewId = await createForIntegration(secondUser, secondIntegrationId);

    expect(firstReviewId).toEqual(expect.any(String));
    expect(secondReviewId).toEqual(expect.any(String));
  });

  it('returns the existing review when idempotent creation hits the same integration scope', async () => {
    const repoFullName = `${REPO}-idempotent-integration-conflict`;
    const existingReviewId = await createCodeReview({
      owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
      platformIntegrationId: firstIntegrationId,
      repoFullName,
      prNumber: 19,
      prUrl: `https://github.com/${repoFullName}/pull/19`,
      prTitle: 'idempotent integration conflict',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/idempotent-integration-conflict',
      headSha: 'idempotent-integration-conflict-head-sha',
      platform: 'github',
    });
    createdReviewIds.push(existingReviewId);

    const result = await db.transaction(tx =>
      createCodeReviewIfAbsentInTransaction(
        tx,
        {
          owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
          platform: 'github',
          repoFullName,
          prNumber: 19,
        },
        {
          owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
          platformIntegrationId: firstIntegrationId,
          repoFullName,
          prNumber: 19,
          prUrl: `https://github.com/${repoFullName}/pull/19`,
          prTitle: 'idempotent integration conflict',
          prAuthor: 'octocat',
          baseRef: 'main',
          headRef: 'feature/idempotent-integration-conflict',
          headSha: 'idempotent-integration-conflict-head-sha',
          platform: 'github',
        }
      )
    );

    expect(result).toEqual({ reviewId: existingReviewId, created: false });
  });

  it('rejects duplicate reviews in the same organization scope', async () => {
    const params = {
      owner: { type: 'org' as const, id: organizationId, userId: firstUser.id },
      platformIntegrationId: organizationIntegrationId,
      repoFullName: `${REPO}-organization-duplicate`,
      prNumber: 22,
      prUrl: `https://github.com/${REPO}-organization-duplicate/pull/22`,
      prTitle: 'organization duplicate identity',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/organization-duplicate',
      headSha: 'organization-duplicate-head-sha',
      platform: 'github' as const,
    };
    const reviewId = await createCodeReview(params);
    createdReviewIds.push(reviewId);

    await expect(createCodeReview(params)).rejects.toThrow();
  });

  it('rejects duplicate reviews for the same integration and allows separate reviews across integrations', async () => {
    const params = {
      owner: { type: 'user' as const, id: firstUser.id, userId: firstUser.id },
      platformIntegrationId: firstIntegrationId,
      repoFullName: `${REPO}-cross-integration-duplicate`,
      prNumber: 23,
      prUrl: `https://github.com/${REPO}-cross-integration-duplicate/pull/23`,
      prTitle: 'cross integration duplicate identity',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/cross-integration-duplicate',
      headSha: 'cross-integration-duplicate-head-sha',
      platform: 'github' as const,
    };
    const reviewId = await createCodeReview(params);
    createdReviewIds.push(reviewId);

    await expect(createCodeReview(params)).rejects.toThrow();

    const alternateReviewId = await createCodeReview({
      ...params,
      platformIntegrationId: alternateFirstUserIntegrationId,
    });
    createdReviewIds.push(alternateReviewId);

    const matchingReview = await findExistingReview(
      {
        owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
        platform: 'github',
        repoFullName: `${REPO}-cross-integration-duplicate`,
        prNumber: 23,
      },
      'cross-integration-duplicate-head-sha'
    );

    expect(matchingReview?.id).toBe(reviewId);
  });

  it('scopes GitLab active review uniqueness to the integration; separate instances are independent', async () => {
    const sharedParams = {
      owner: { type: 'user' as const, id: firstUser.id, userId: firstUser.id },
      repoFullName: `${REPO}-gitlab-instance-scope`,
      prNumber: 24,
      prUrl: `https://gitlab-a.example.com/${REPO}-gitlab-instance-scope/-/merge_requests/24`,
      prTitle: 'GitLab instance scoped identity',
      prAuthor: 'gitlab-user',
      baseRef: 'main',
      headRef: 'feature/gitlab-instance-scope',
      headSha: 'gitlab-instance-scope-head-sha',
      platform: 'gitlab' as const,
      platformProjectId: 501,
    };
    const firstReviewId = await createCodeReview({
      ...sharedParams,
      platformIntegrationId: firstGitLabIntegrationId,
    });
    createdReviewIds.push(firstReviewId);

    await expect(
      createCodeReview({
        ...sharedParams,
        platformIntegrationId: firstGitLabIntegrationId,
      })
    ).rejects.toThrow();

    const secondReviewId = await createCodeReview({
      ...sharedParams,
      platformIntegrationId: secondGitLabIntegrationId,
      prUrl: `https://gitlab-b.example.com/${REPO}-gitlab-instance-scope/-/merge_requests/24`,
    });
    createdReviewIds.push(secondReviewId);
  });

  it('persists Bitbucket reviews without provider UUID identity columns', async () => {
    const reviewId = await createCodeReview({
      owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
      platformIntegrationId: bitbucketIntegrationId,
      repoFullName: 'workspace/repository',
      prNumber: 7,
      prUrl: 'https://bitbucket.org/workspace/repository/pull-requests/7',
      prTitle: 'Bitbucket review identity',
      prAuthor: 'bitbucket-user',
      baseRef: 'main',
      headRef: 'feature/bitbucket',
      headSha: 'bitbucket-head-sha',
      platform: 'bitbucket',
    });
    createdReviewIds.push(reviewId);

    const [review] = await db
      .select({
        platform: cloud_agent_code_reviews.platform,
        repoFullName: cloud_agent_code_reviews.repo_full_name,
        prAuthorGithubId: cloud_agent_code_reviews.pr_author_github_id,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId));

    expect(review).toEqual({
      platform: 'bitbucket',
      repoFullName: 'workspace/repository',
      prAuthorGithubId: null,
    });
  });

  it('finds a duplicate within the exact owner and repository scope', async () => {
    const firstReviewId = await createCodeReview({
      owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
      platformIntegrationId: firstIntegrationId,
      repoFullName: `${REPO}-exact-duplicate`,
      prNumber: 18,
      prUrl: `https://github.com/${REPO}-exact-duplicate/pull/18`,
      prTitle: 'exact duplicate identity',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/exact-duplicate',
      headSha: 'exact-duplicate-head-sha',
      platform: 'github',
    });
    createdReviewIds.push(firstReviewId);

    const matchingReview = await findExistingReview(
      {
        owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
        platform: 'github',
        repoFullName: `${REPO}-exact-duplicate`,
        prNumber: 18,
      },
      'exact-duplicate-head-sha'
    );
    const otherOwnerReview = await findExistingReview(
      {
        owner: { type: 'user', id: secondUser.id, userId: secondUser.id },
        platform: 'github',
        repoFullName: `${REPO}-exact-duplicate`,
        prNumber: 18,
      },
      'exact-duplicate-head-sha'
    );

    expect(matchingReview?.id).toBe(firstReviewId);
    expect(otherOwnerReview).toBeNull();
  });

  it('finds active reviews within the exact owner and repository scope across integrations', async () => {
    const createActiveReview = async (
      user: User,
      platformIntegrationId: string,
      headSha: string
    ) => {
      const id = await createCodeReview({
        owner: { type: 'user', id: user.id, userId: user.id },
        platformIntegrationId,
        repoFullName: `${REPO}-active-scope`,
        prNumber: 20,
        prUrl: `https://github.com/${REPO}-active-scope/pull/20`,
        prTitle: 'active review scope',
        prAuthor: 'octocat',
        baseRef: 'main',
        headRef: 'feature/active-scope',
        headSha,
        platform: 'github',
      });
      createdReviewIds.push(id);
      return id;
    };
    const matchingReviewId = await createActiveReview(
      firstUser,
      firstIntegrationId,
      'active-scope-old-head'
    );
    const alternateIntegrationReviewId = await createActiveReview(
      firstUser,
      alternateFirstUserIntegrationId,
      'active-scope-other-integration-head'
    );
    await createActiveReview(secondUser, secondIntegrationId, 'active-scope-other-owner-head');

    const activeReviewIds = await findActiveReviewsForPR(
      {
        owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
        platform: 'github',
        repoFullName: `${REPO}-active-scope`,
        prNumber: 20,
      },
      'active-scope-new-head'
    );

    expect(activeReviewIds).toHaveLength(2);
    expect(activeReviewIds).toEqual(
      expect.arrayContaining([matchingReviewId, alternateIntegrationReviewId])
    );
  });

  it('orders running active reviews before queued and pending fallback reviews', async () => {
    const createActiveReview = async (headSha: string, platformIntegrationId: string) => {
      const id = await createCodeReview({
        owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
        platformIntegrationId,
        repoFullName: `${REPO}-active-priority`,
        prNumber: 25,
        prUrl: `https://github.com/${REPO}-active-priority/pull/25`,
        prTitle: 'active review priority',
        prAuthor: 'octocat',
        baseRef: 'main',
        headRef: 'feature/active-priority',
        headSha,
        platform: 'github',
      });
      createdReviewIds.push(id);
      return id;
    };

    const pendingReviewId = await createActiveReview(
      'active-priority-pending-head',
      firstIntegrationId
    );
    const queuedReviewId = await createActiveReview(
      'active-priority-queued-head',
      alternateFirstUserIntegrationId
    );
    const runningReviewId = await createActiveReview(
      'active-priority-running-head',
      secondIntegrationId
    );
    await updateCodeReviewStatus(queuedReviewId, 'queued');
    await updateCodeReviewStatus(runningReviewId, 'running');

    const activeReviewIds = await findActiveReviewsForPR(
      {
        owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
        platform: 'github',
        repoFullName: `${REPO}-active-priority`,
        prNumber: 25,
      },
      'active-priority-new-head'
    );

    expect(activeReviewIds).toEqual([runningReviewId, queuedReviewId, pendingReviewId]);
  });

  it('finds previous completed review context within the exact owner and repository scope across integrations', async () => {
    const createCompletedReview = async (
      user: User,
      platformIntegrationId: string,
      sessionId: string,
      headSha: string
    ) => {
      const id = await createCodeReview({
        owner: { type: 'user', id: user.id, userId: user.id },
        platformIntegrationId,
        repoFullName: `${REPO}-previous-scope`,
        prNumber: 21,
        prUrl: `https://github.com/${REPO}-previous-scope/pull/21`,
        prTitle: 'previous review scope',
        prAuthor: 'octocat',
        baseRef: 'main',
        headRef: 'feature/previous-scope',
        headSha,
        platform: 'github',
      });
      createdReviewIds.push(id);
      await updateCodeReviewStatus(id, 'completed', { sessionId });
      return id;
    };
    await createCompletedReview(
      firstUser,
      firstIntegrationId,
      'agent_matching_previous',
      'previous-scope-old-head'
    );
    await createCompletedReview(
      firstUser,
      alternateFirstUserIntegrationId,
      'agent_alternate_integration_previous',
      'previous-scope-alternate-integration-head'
    );
    await createCompletedReview(
      secondUser,
      secondIntegrationId,
      'agent_other_owner_previous',
      'previous-scope-other-owner-head'
    );

    const previousReview = await findPreviousCompletedReview(
      {
        owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
        platform: 'github',
        repoFullName: `${REPO}-previous-scope`,
        prNumber: 21,
      },
      'previous-scope-current-head'
    );

    expect(previousReview).toEqual({
      head_sha: 'previous-scope-alternate-integration-head',
      session_id: 'agent_alternate_integration_previous',
    });
  });

  it('supersedes active reviews only for the exact owner scope', async () => {
    const createActiveReview = async (
      user: User,
      platformIntegrationId: string,
      headSha: string
    ) => {
      const id = await createCodeReview({
        owner: { type: 'user', id: user.id, userId: user.id },
        platformIntegrationId,
        repoFullName: `${REPO}-owner-supersession`,
        prNumber: 19,
        prUrl: `https://github.com/${REPO}-owner-supersession/pull/19`,
        prTitle: 'owner-scoped supersession',
        prAuthor: 'octocat',
        baseRef: 'main',
        headRef: 'feature/owner-supersession',
        headSha,
        platform: 'github',
      });
      createdReviewIds.push(id);
      return id;
    };
    const matchingReviewId = await createActiveReview(
      firstUser,
      firstIntegrationId,
      'owner-supersession-old-head'
    );
    const alternateIntegrationReviewId = await createActiveReview(
      firstUser,
      alternateFirstUserIntegrationId,
      'owner-supersession-other-integration-head'
    );
    const otherOwnerReviewId = await createActiveReview(
      secondUser,
      secondIntegrationId,
      'owner-supersession-other-owner-head'
    );

    const cancelled = await cancelSupersededReviewsForPR(
      {
        owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
        platform: 'github',
        repoFullName: `${REPO}-owner-supersession`,
        prNumber: 19,
      },
      'owner-supersession-new-head'
    );

    const [otherOwnerReview] = await db
      .select({ status: cloud_agent_code_reviews.status })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, otherOwnerReviewId));
    expect(cancelled.map(review => review.id)).toEqual(
      expect.arrayContaining([matchingReviewId, alternateIntegrationReviewId])
    );
    expect(cancelled).toHaveLength(2);
    expect(otherOwnerReview?.status).toBe('pending');
  });

  it('builds a deterministic integration-scoped Bitbucket lifecycle lock key', () => {
    expect(bitbucketCodeReviewerLifecycleLockKey(organizationIntegrationId)).toBe(
      `bitbucket-code-review-lifecycle:${organizationIntegrationId}`
    );
    expect(bitbucketCodeReviewerLifecycleLockKey(organizationIntegrationId)).not.toBe(
      bitbucketCodeReviewerLifecycleLockKey(firstIntegrationId)
    );
  });

  it('atomically disables Bitbucket Code Reviewer and cancels active integration work', async () => {
    await db.insert(agent_configs).values({
      owned_by_organization_id: organizationId,
      agent_type: 'code_review',
      platform: 'bitbucket',
      config: {
        review_style: 'balanced',
        focus_areas: [],
        model_slug: 'test-model',
        repository_selection_mode: 'selected',
        selected_repository_ids: ['22222222-2222-4222-8222-222222222222'],
      },
      is_enabled: true,
      created_by: firstUser.id,
    });
    const reviewId = await createCodeReview({
      owner: { type: 'org', id: organizationId, userId: firstUser.id },
      platformIntegrationId: organizationIntegrationId,
      repoFullName: `${REPO}-bitbucket-lifecycle`,
      prNumber: 29,
      prUrl: `https://bitbucket.org/${REPO}-bitbucket-lifecycle/pull-requests/29`,
      prTitle: 'lifecycle disable',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/lifecycle-disable',
      headSha: 'bitbucket-lifecycle-disable',
      platform: 'bitbucket',
    });
    createdReviewIds.push(reviewId);
    await updateCodeReviewStatus(reviewId, 'queued');
    const attempt = await createCodeReviewAttempt({ codeReviewId: reviewId, status: 'queued' });

    const cancelled = await disableBitbucketCodeReviewerForIntegration({
      organizationId,
      integrationId: organizationIntegrationId,
    });

    const [config] = await db
      .select({ isEnabled: agent_configs.is_enabled })
      .from(agent_configs)
      .where(
        and(
          eq(agent_configs.owned_by_organization_id, organizationId),
          eq(agent_configs.platform, 'bitbucket')
        )
      );
    const [review] = await db
      .select({ status: cloud_agent_code_reviews.status })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId));
    const [storedAttempt] = await db
      .select({ status: cloud_agent_code_review_attempts.status })
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, attempt.id));

    expect(cancelled).toEqual([
      expect.objectContaining({
        id: reviewId,
        prevStatus: 'queued',
        latestActiveAttemptId: attempt.id,
      }),
    ]);
    expect(config?.isEnabled).toBe(false);
    expect(review?.status).toBe('cancelled');
    expect(storedAttempt?.status).toBe('cancelled');

    const [ledgerRow] = await db
      .select({ status: operation_ledgers.status })
      .from(operation_ledgers)
      .where(eq(operation_ledgers.operation_key, `review:${reviewId}`));
    expect(ledgerRow?.status).toBe('no_op');

    await db
      .delete(agent_configs)
      .where(
        and(
          eq(agent_configs.owned_by_organization_id, organizationId),
          eq(agent_configs.platform, 'bitbucket')
        )
      );
  });

  it('cancels active organization reviews and attempts for one integration', async () => {
    const createOrganizationReview = async (prNumber: number) => {
      const id = await createCodeReview({
        owner: { type: 'org', id: organizationId, userId: firstUser.id },
        platformIntegrationId: organizationIntegrationId,
        repoFullName: `${REPO}-integration-disconnect`,
        prNumber,
        prUrl: `https://github.com/${REPO}-integration-disconnect/pull/${prNumber}`,
        prTitle: 'integration disconnect',
        prAuthor: 'octocat',
        baseRef: 'main',
        headRef: `feature/integration-disconnect-${prNumber}`,
        headSha: `integration-disconnect-${prNumber}`,
        platform: 'github',
      });
      createdReviewIds.push(id);
      return id;
    };
    const pendingReviewId = await createOrganizationReview(30);
    const queuedReviewId = await createOrganizationReview(31);
    const runningReviewId = await createOrganizationReview(32);
    const completedReviewId = await createOrganizationReview(33);
    await updateCodeReviewStatus(queuedReviewId, 'queued');
    await updateCodeReviewStatus(runningReviewId, 'running');
    await updateCodeReviewStatus(completedReviewId, 'completed');
    const queuedAttempt = await createCodeReviewAttempt({
      codeReviewId: queuedReviewId,
      status: 'queued',
    });
    const runningAttempt = await createCodeReviewAttempt({
      codeReviewId: runningReviewId,
      status: 'running',
    });

    const cancelled = await cancelActiveCodeReviewsForIntegration({
      organizationId,
      platform: 'github',
      integrationId: organizationIntegrationId,
    });

    expect(cancelled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pendingReviewId, prevStatus: 'pending' }),
        expect.objectContaining({
          id: queuedReviewId,
          prevStatus: 'queued',
          latestActiveAttemptId: queuedAttempt.id,
        }),
        expect.objectContaining({
          id: runningReviewId,
          prevStatus: 'running',
          latestActiveAttemptId: runningAttempt.id,
        }),
      ])
    );
    const reviews = await db
      .select({ id: cloud_agent_code_reviews.id, status: cloud_agent_code_reviews.status })
      .from(cloud_agent_code_reviews)
      .where(
        inArray(cloud_agent_code_reviews.id, [
          pendingReviewId,
          queuedReviewId,
          runningReviewId,
          completedReviewId,
        ])
      );
    expect(
      reviews.filter(review => review.id !== completedReviewId).map(review => review.status)
    ).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(reviews.find(review => review.id === completedReviewId)?.status).toBe('completed');
    const attempts = await db
      .select({ status: cloud_agent_code_review_attempts.status })
      .from(cloud_agent_code_review_attempts)
      .where(inArray(cloud_agent_code_review_attempts.id, [queuedAttempt.id, runningAttempt.id]));
    expect(attempts.map(attempt => attempt.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('settles the admitted ledger row for user-cancelled reviews', async () => {
    const reviewId = await createCodeReview({
      owner: { type: 'org', id: organizationId, userId: firstUser.id },
      platformIntegrationId: organizationIntegrationId,
      repoFullName: `${REPO}-ledger-user-cancel`,
      prNumber: 36,
      prUrl: `https://github.com/${REPO}-ledger-user-cancel/pull/36`,
      prTitle: 'ledger user cancel settle',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/ledger-user-cancel-settle',
      headSha: 'ledger-user-cancel-settle-head-sha',
      platform: 'github',
      triggerSource: 'manual',
    });
    createdReviewIds.push(reviewId);

    const cancelled = await cancelActiveCodeReviewsForIntegration({
      organizationId,
      platform: 'github',
      integrationId: organizationIntegrationId,
    });

    expect(cancelled.map(row => row.id)).toContain(reviewId);
    expect(cancelled.find(row => row.id === reviewId)?.triggerSource).toBe('manual');

    const [ledgerRow] = await db
      .select({ status: operation_ledgers.status })
      .from(operation_ledgers)
      .where(eq(operation_ledgers.operation_key, `review:${reviewId}`));
    expect(ledgerRow?.status).toBe('no_op');
  });

  it('admits a code_review ledger row with the mapped intent on create', async () => {
    const reviewId = await createCodeReview({
      owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
      platformIntegrationId: firstIntegrationId,
      repoFullName: `${REPO}-ledger-admit`,
      prNumber: 34,
      prUrl: `https://github.com/${REPO}-ledger-admit/pull/34`,
      prTitle: 'ledger admit',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/ledger-admit',
      headSha: 'ledger-admit-head-sha',
      platform: 'github',
      triggerSource: 'webhook',
    });
    createdReviewIds.push(reviewId);

    const [ledgerRow] = await db
      .select({
        domain: operation_ledgers.domain,
        operationKey: operation_ledgers.operation_key,
        intent: operation_ledgers.intent,
      })
      .from(operation_ledgers)
      .where(eq(operation_ledgers.operation_key, `review:${reviewId}`));

    expect(ledgerRow).toEqual({
      domain: 'code_review',
      operationKey: `review:${reviewId}`,
      intent: 'webhook',
    });
  });

  it('does not admit a code_review ledger row inside the creation transaction', async () => {
    const repoFullName = `${REPO}-ledger-transaction-no-admit`;
    const result = await db.transaction(tx =>
      createCodeReviewIfAbsentInTransaction(
        tx,
        {
          owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
          platform: 'github',
          repoFullName,
          prNumber: 35,
        },
        {
          owner: { type: 'user', id: firstUser.id, userId: firstUser.id },
          platformIntegrationId: firstIntegrationId,
          repoFullName,
          prNumber: 35,
          prUrl: `https://github.com/${repoFullName}/pull/35`,
          prTitle: 'ledger transaction no admit',
          prAuthor: 'octocat',
          baseRef: 'main',
          headRef: 'feature/ledger-transaction-no-admit',
          headSha: 'ledger-transaction-no-admit-head-sha',
          platform: 'github',
          triggerSource: 'webhook',
        }
      )
    );
    expect(result.created).toBe(true);
    createdReviewIds.push(result.reviewId);

    const ledgerRows = await db
      .select({ id: operation_ledgers.id })
      .from(operation_ledgers)
      .where(eq(operation_ledgers.operation_key, `review:${result.reviewId}`));

    expect(ledgerRows).toHaveLength(0);
  });
});

describe('cancelSupersededReviewsForPR', () => {
  let testUser: User;
  let githubIntegrationId: string;
  let secondGithubIntegrationId: string;
  let thirdGithubIntegrationId: string;
  let gitLabIntegrationId: string;
  const createdReviewIds: string[] = [];
  const repo = `${REPO}-superseded`;

  beforeAll(async () => {
    testUser = await insertTestUser();
    const integrations = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_user_id: testUser.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: `supersession-github-${Date.now()}`,
          platform_account_id: 'supersession-github',
          platform_account_login: 'supersession-github',
          repository_access: 'all',
          integration_status: 'active',
        },
        {
          owned_by_user_id: testUser.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: `supersession-github-2-${Date.now()}`,
          platform_account_id: 'supersession-github-2',
          platform_account_login: 'supersession-github-2',
          repository_access: 'all',
          integration_status: 'active',
        },
        {
          owned_by_user_id: testUser.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: `supersession-github-3-${Date.now()}`,
          platform_account_id: 'supersession-github-3',
          platform_account_login: 'supersession-github-3',
          repository_access: 'all',
          integration_status: 'active',
        },
        {
          owned_by_user_id: testUser.id,
          platform: 'gitlab',
          integration_type: 'oauth',
          platform_installation_id: `supersession-gitlab-${Date.now()}`,
          platform_account_id: 'supersession-gitlab',
          platform_account_login: 'supersession-gitlab',
          repository_access: 'all',
          integration_status: 'active',
        },
      ])
      .returning({ id: platform_integrations.id, platform: platform_integrations.platform });
    const githubIntegrations = integrations.filter(
      integration => integration.platform === 'github'
    );
    const gitLabIntegration = integrations.find(integration => integration.platform === 'gitlab');
    if (githubIntegrations.length < 3 || !gitLabIntegration) {
      throw new Error('Expected supersession integrations');
    }
    githubIntegrationId = githubIntegrations[0].id;
    secondGithubIntegrationId = githubIntegrations[1].id;
    thirdGithubIntegrationId = githubIntegrations[2].id;
    gitLabIntegrationId = gitLabIntegration.id;
  });

  afterAll(async () => {
    for (const id of createdReviewIds) {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, id));
    }
    await db
      .delete(platform_integrations)
      .where(
        inArray(platform_integrations.id, [
          githubIntegrationId,
          secondGithubIntegrationId,
          thirdGithubIntegrationId,
          gitLabIntegrationId,
        ])
      );
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function createReview({
    headSha,
    prNumber = 42,
    repoFullName = repo,
    platform = 'github' as const,
    platformProjectId,
    platformIntegrationId: overrideIntegrationId,
  }: {
    headSha: string;
    prNumber?: number;
    repoFullName?: string;
    platform?: 'github' | 'gitlab';
    platformProjectId?: number;
    platformIntegrationId?: string;
  }) {
    const platformIntegrationId =
      overrideIntegrationId ?? (platform === 'gitlab' ? gitLabIntegrationId : githubIntegrationId);
    if (platform === 'gitlab') {
      if (platformProjectId === undefined) {
        throw new Error('GitLab review test fixtures require platformProjectId');
      }
    }
    const id = await createCodeReview({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      platformIntegrationId,
      repoFullName,
      prNumber,
      prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
      prTitle: 'test PR',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: `feature/${headSha}`,
      headSha,
      platform,
      platformProjectId,
    });
    createdReviewIds.push(id);
    return id;
  }

  it('cancels active rows only for the scoped integration and leaves other integrations alone', async () => {
    const pendingId = await createReview({
      headSha: 'sha-pending',
      platformIntegrationId: githubIntegrationId,
    });
    const otherIntegrationId = await createReview({
      headSha: 'sha-other-integration',
      platformIntegrationId: secondGithubIntegrationId,
    });
    const pendingAttempt = await createCodeReviewAttempt({
      codeReviewId: pendingId,
      status: 'pending',
    });

    const cancelled = await cancelSupersededReviewsForPR(
      {
        owner: { type: 'user', id: testUser.id, userId: testUser.id },
        platform: 'github',
        repoFullName: repo,
        prNumber: 42,
        platformIntegrationId: githubIntegrationId,
      },
      'sha-latest'
    );

    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toEqual(
      expect.objectContaining({
        id: pendingId,
        prevStatus: 'pending',
        headSha: 'sha-pending',
        latestActiveAttemptId: pendingAttempt.id,
      })
    );

    const rows = await db
      .select({
        id: cloud_agent_code_reviews.id,
        status: cloud_agent_code_reviews.status,
        terminalReason: cloud_agent_code_reviews.terminal_reason,
        errorMessage: cloud_agent_code_reviews.error_message,
        completedAt: cloud_agent_code_reviews.completed_at,
        startedAt: cloud_agent_code_reviews.started_at,
        sessionId: cloud_agent_code_reviews.session_id,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, repo));

    const cancelledRow = rows.find(row => row.id === pendingId);
    expect(cancelledRow?.status).toBe('cancelled');
    expect(cancelledRow?.terminalReason).toBe('superseded');
    expect(cancelledRow?.errorMessage).toBe('Superseded by new push');
    expect(cancelledRow?.completedAt).not.toBeNull();
    expect(cancelledRow?.startedAt).toBeNull();
    expect(cancelledRow?.sessionId).toBeNull();

    const otherIntegrationRow = rows.find(row => row.id === otherIntegrationId);
    expect(otherIntegrationRow?.status).toBe('pending');
    expect(otherIntegrationRow?.terminalReason).toBeNull();

    await updateCodeReviewStatus(otherIntegrationId, 'cancelled', {
      terminalReason: 'superseded',
      errorMessage: 'Cleaned up by test',
    });

    const attempts = await db
      .select({
        id: cloud_agent_code_review_attempts.id,
        status: cloud_agent_code_review_attempts.status,
        terminalReason: cloud_agent_code_review_attempts.terminal_reason,
        errorMessage: cloud_agent_code_review_attempts.error_message,
        completedAt: cloud_agent_code_review_attempts.completed_at,
      })
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, pendingId));

    expect(attempts).toEqual([
      expect.objectContaining({
        id: pendingAttempt.id,
        status: 'cancelled',
        terminalReason: 'superseded',
        errorMessage: 'Superseded by new push',
        completedAt: expect.any(String),
      }),
    ]);
  });

  it('cancels only named active review IDs', async () => {
    const keptId = await createReview({
      headSha: 'sha-id-cancel-kept',
      prNumber: 44,
      platformIntegrationId: githubIntegrationId,
    });
    const queuedDuplicateId = await createReview({
      headSha: 'sha-id-cancel-queued',
      prNumber: 44,
      platformIntegrationId: secondGithubIntegrationId,
    });
    const runningDuplicateId = await createReview({
      headSha: 'sha-id-cancel-running',
      prNumber: 44,
      platformIntegrationId: thirdGithubIntegrationId,
    });
    const unrelatedId = await createReview({ headSha: 'sha-id-cancel-unrelated', prNumber: 45 });
    const queuedAttempt = await createCodeReviewAttempt({
      codeReviewId: queuedDuplicateId,
      status: 'queued',
      sessionId: 'session-id-cancel-queued',
    });
    const runningAttempt = await createCodeReviewAttempt({
      codeReviewId: runningDuplicateId,
      status: 'running',
      sessionId: 'session-id-cancel-running',
    });

    await updateCodeReviewStatus(queuedDuplicateId, 'queued', {
      sessionId: 'session-id-cancel-queued',
    });
    await updateCodeReviewStatus(runningDuplicateId, 'running', {
      sessionId: 'session-id-cancel-running',
    });
    await updateCodeReviewStatus(unrelatedId, 'running', {
      sessionId: 'session-id-cancel-unrelated',
    });

    const cancelled = await cancelActiveCodeReviewsById(
      [queuedDuplicateId, runningDuplicateId],
      'Superseded by duplicate merge-commit continuation'
    );

    expect(cancelled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: queuedDuplicateId,
          prevStatus: 'queued',
          latestActiveAttemptId: queuedAttempt.id,
        }),
        expect.objectContaining({
          id: runningDuplicateId,
          prevStatus: 'running',
          latestActiveAttemptId: runningAttempt.id,
        }),
      ])
    );

    const rows = await db
      .select({
        id: cloud_agent_code_reviews.id,
        status: cloud_agent_code_reviews.status,
        terminalReason: cloud_agent_code_reviews.terminal_reason,
        errorMessage: cloud_agent_code_reviews.error_message,
      })
      .from(cloud_agent_code_reviews)
      .where(
        inArray(cloud_agent_code_reviews.id, [
          keptId,
          queuedDuplicateId,
          runningDuplicateId,
          unrelatedId,
        ])
      );
    const statusById = new Map(rows.map(row => [row.id, row]));

    expect(statusById.get(keptId)?.status).toBe('pending');
    expect(statusById.get(unrelatedId)?.status).toBe('running');
    expect(statusById.get(queuedDuplicateId)).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        terminalReason: 'superseded',
        errorMessage: 'Superseded by duplicate merge-commit continuation',
      })
    );
    expect(statusById.get(runningDuplicateId)).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        terminalReason: 'superseded',
        errorMessage: 'Superseded by duplicate merge-commit continuation',
      })
    );
  });

  it('ignores same-sha, different repo or pr, and already-terminal rows; second call is idempotent', async () => {
    const sameShaId = await createReview({
      headSha: 'sha-keep',
      platformIntegrationId: githubIntegrationId,
    });
    const otherPrId = await createReview({ headSha: 'sha-other-pr', prNumber: 43 });
    const otherRepoId = await createReview({
      headSha: 'sha-other-repo',
      repoFullName: `${repo}-other`,
    });
    const terminalCompletedId = await createReview({
      headSha: 'sha-completed',
      platformIntegrationId: secondGithubIntegrationId,
    });
    await updateCodeReviewStatus(terminalCompletedId, 'completed');
    const terminalFailedId = await createReview({
      headSha: 'sha-failed',
      platformIntegrationId: secondGithubIntegrationId,
    });
    await updateCodeReviewStatus(terminalFailedId, 'failed', {
      errorMessage: 'failed before cancel',
    });
    const otherPlatformId = await createReview({
      headSha: 'sha-gitlab',
      platform: 'gitlab',
      platformProjectId: 999,
    });
    const targetId = await createReview({
      headSha: 'sha-target',
      platformIntegrationId: thirdGithubIntegrationId,
    });

    const reviewScope = {
      owner: { type: 'user' as const, id: testUser.id, userId: testUser.id },
      platform: 'github' as const,
      repoFullName: repo,
      prNumber: 42,
    };
    const cancelled = await cancelSupersededReviewsForPR(reviewScope, 'sha-keep');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toEqual(
      expect.objectContaining({
        id: targetId,
        prevStatus: 'pending',
        headSha: 'sha-target',
        platform: 'github',
        platformIntegrationId: thirdGithubIntegrationId,
      })
    );

    const cancelledAgain = await cancelSupersededReviewsForPR(reviewScope, 'sha-keep');
    expect(cancelledAgain).toEqual([]);

    const rows = await db
      .select({
        id: cloud_agent_code_reviews.id,
        status: cloud_agent_code_reviews.status,
        terminalReason: cloud_agent_code_reviews.terminal_reason,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, repo));

    expect(rows.find(row => row.id === sameShaId)?.status).toBe('pending');
    expect(rows.find(row => row.id === targetId)?.status).toBe('cancelled');
    expect(rows.find(row => row.id === otherPlatformId)?.status).toBe('pending');
    expect(rows.find(row => row.id === otherPrId)?.status).toBe('pending');
    expect(rows.find(row => row.id === terminalCompletedId)?.status).toBe('completed');
    expect(rows.find(row => row.id === terminalFailedId)?.status).toBe('failed');

    const [otherRepoRow] = await db
      .select({ status: cloud_agent_code_reviews.status })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, otherRepoId))
      .limit(1);
    expect(otherRepoRow?.status).toBe('pending');
  });

  it('settles the admitted ledger row for superseded reviews', async () => {
    const reviewId = await createCodeReview({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      platformIntegrationId: githubIntegrationId,
      repoFullName: repo,
      prNumber: 46,
      prUrl: `https://github.com/${repo}/pull/46`,
      prTitle: 'ledger superseded settle',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/ledger-superseded-settle',
      headSha: 'sha-ledger-superseded-settle',
      platform: 'github',
      triggerSource: 'webhook',
    });
    createdReviewIds.push(reviewId);

    const cancelled = await cancelSupersededReviewsForPR(
      {
        owner: { type: 'user', id: testUser.id, userId: testUser.id },
        platform: 'github',
        repoFullName: repo,
        prNumber: 46,
        platformIntegrationId: githubIntegrationId,
      },
      'sha-ledger-superseded-settle-new'
    );

    expect(cancelled.map(row => row.id)).toEqual([reviewId]);
    expect(cancelled[0]?.triggerSource).toBe('webhook');

    const [ledgerRow] = await db
      .select({ status: operation_ledgers.status })
      .from(operation_ledgers)
      .where(eq(operation_ledgers.operation_key, `review:${reviewId}`));
    expect(ledgerRow?.status).toBe('superseded');
  });
});

describe('findPreviousCompletedReview', () => {
  let testUser: User;
  let githubIntegrationId: string;
  let gitLabIntegrationAId: string;
  let gitLabIntegrationBId: string;
  const createdReviewIds: string[] = [];
  const gitLabRepo = `${REPO}-gitlab-scope`;

  beforeAll(async () => {
    testUser = await insertTestUser();
    const [githubIntegration, gitLabIntegrationA, gitLabIntegrationB] = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_user_id: testUser.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: `github-${Date.now()}-${Math.random()}`,
          platform_account_id: 'github',
          platform_account_login: 'github',
          repository_access: 'all',
          integration_status: 'active',
        },
        {
          owned_by_user_id: testUser.id,
          platform: 'gitlab',
          integration_type: 'oauth',
          platform_installation_id: `gitlab-a-${Date.now()}-${Math.random()}`,
          platform_account_id: 'gitlab-a',
          platform_account_login: 'gitlab-a',
          repository_access: 'all',
          integration_status: 'active',
        },
        {
          owned_by_user_id: testUser.id,
          platform: 'gitlab',
          integration_type: 'oauth',
          platform_installation_id: `gitlab-b-${Date.now()}-${Math.random()}`,
          platform_account_id: 'gitlab-b',
          platform_account_login: 'gitlab-b',
          repository_access: 'all',
          integration_status: 'active',
        },
      ])
      .returning({ id: platform_integrations.id });
    if (!githubIntegration || !gitLabIntegrationA || !gitLabIntegrationB) {
      throw new Error('Expected review continuation integrations');
    }
    githubIntegrationId = githubIntegration.id;
    gitLabIntegrationAId = gitLabIntegrationA.id;
    gitLabIntegrationBId = gitLabIntegrationB.id;
  });

  afterEach(async () => {
    const activeIds = await db
      .select({ id: cloud_agent_code_reviews.id })
      .from(cloud_agent_code_reviews)
      .where(
        and(
          inArray(cloud_agent_code_reviews.id, createdReviewIds),
          inArray(cloud_agent_code_reviews.status, ['pending', 'queued', 'running'])
        )
      );
    for (const { id } of activeIds) {
      await updateCodeReviewStatus(id, 'cancelled', {
        terminalReason: 'superseded',
        errorMessage: 'Cleaned up by test',
      });
    }
  });

  afterAll(async () => {
    for (const id of createdReviewIds) {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, id));
    }
    await db
      .delete(platform_integrations)
      .where(
        inArray(platform_integrations.id, [
          githubIntegrationId,
          gitLabIntegrationAId,
          gitLabIntegrationBId,
        ])
      );
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function createReview(headSha: string) {
    const id = await createCodeReview({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      platformIntegrationId: githubIntegrationId,
      repoFullName: REPO,
      prNumber: 42,
      prUrl: `https://github.com/${REPO}/pull/42`,
      prTitle: 'test PR',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/test',
      headSha,
      platform: 'github',
    });
    createdReviewIds.push(id);
    return id;
  }

  async function createGitLabReview(headSha: string, integrationId: string, projectId: number) {
    const id = await createCodeReview({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      repoFullName: gitLabRepo,
      prNumber: 42,
      prUrl: `https://gitlab.example.com/${gitLabRepo}/-/merge_requests/42`,
      prTitle: 'test GitLab MR',
      prAuthor: 'gitlab-user',
      baseRef: 'main',
      headRef: 'feature/test',
      headSha,
      platform: 'gitlab',
      platformIntegrationId: integrationId,
      platformProjectId: projectId,
    });
    createdReviewIds.push(id);
    return id;
  }

  function githubReviewScope() {
    return {
      owner: { type: 'user' as const, id: testUser.id, userId: testUser.id },
      platform: 'github' as const,
      repoFullName: REPO,
      prNumber: 42,
    };
  }

  it('returns null when no previous completed review exists', async () => {
    const result = await findPreviousCompletedReview(githubReviewScope(), 'abc123');
    expect(result).toBeNull();
  });

  it('returns head_sha and session_id: null for a completed review without session', async () => {
    const id = await createReview('sha-no-session');
    await updateCodeReviewStatus(id, 'completed');

    const result = await findPreviousCompletedReview(githubReviewScope(), 'other-sha');
    expect(result).not.toBeNull();
    expect(result!.head_sha).toBe('sha-no-session');
    expect(result!.session_id).toBeNull();
  });

  it('returns head_sha and session_id for a completed review with session', async () => {
    const id = await createReview('sha-with-session');
    await updateCodeReviewStatus(id, 'completed', {
      sessionId: 'agent_test123',
    });

    const result = await findPreviousCompletedReview(githubReviewScope(), 'other-sha');
    expect(result).not.toBeNull();
    expect(result!.head_sha).toBe('sha-with-session');
    expect(result!.session_id).toBe('agent_test123');
  });

  it('excludes the current SHA', async () => {
    const result = await findPreviousCompletedReview(githubReviewScope(), 'sha-with-session');
    // Should skip "sha-with-session" and fall back to "sha-no-session"
    expect(result).not.toBeNull();
    expect(result!.head_sha).toBe('sha-no-session');
  });

  it('returns the most recent completed review', async () => {
    const id = await createReview('sha-newer');
    await updateCodeReviewStatus(id, 'completed', {
      sessionId: 'agent_newer',
    });

    const result = await findPreviousCompletedReview(githubReviewScope(), 'other-sha');
    expect(result).not.toBeNull();
    expect(result!.head_sha).toBe('sha-newer');
    expect(result!.session_id).toBe('agent_newer');
  });

  it('ignores non-completed reviews', async () => {
    const id = await createReview('sha-running');
    await updateCodeReviewStatus(id, 'running', {
      sessionId: 'agent_running',
    });

    // Should still return the most recent *completed* one
    const result = await findPreviousCompletedReview(githubReviewScope(), 'other-sha');
    expect(result).not.toBeNull();
    expect(result!.head_sha).toBe('sha-newer');
    expect(result!.session_id).toBe('agent_newer');
  });

  it('ensures session_id and head_sha come from the same row', async () => {
    // Create a completed review with no session (simulates v1 legacy)
    const legacyId = await createReview('sha-legacy-newest');
    await updateCodeReviewStatus(legacyId, 'completed');

    const result = await findPreviousCompletedReview(githubReviewScope(), 'other-sha');
    expect(result).not.toBeNull();
    // The newest completed review has no session — both fields from same row
    expect(result!.head_sha).toBe('sha-legacy-newest');
    expect(result!.session_id).toBeNull();
  });

  it('keeps GitLab session continuation on repo-name scope until provider-stable identity lands', async () => {
    const olderIntegrationId = await createGitLabReview(
      'gitlab-older-integration-sha',
      gitLabIntegrationAId,
      501
    );
    const newerIntegrationId = await createGitLabReview(
      'gitlab-newer-integration-sha',
      gitLabIntegrationBId,
      501
    );
    await updateCodeReviewStatus(olderIntegrationId, 'completed', {
      sessionId: 'agent_older_integration',
    });
    await updateCodeReviewStatus(newerIntegrationId, 'completed', {
      sessionId: 'agent_newer_integration',
    });
    const differentProjectId = await createGitLabReview(
      'gitlab-matching-sha',
      gitLabIntegrationAId,
      502
    );
    await updateCodeReviewStatus(differentProjectId, 'completed', {
      sessionId: 'agent_other_project',
    });

    const result = await findPreviousCompletedReview(
      {
        owner: { type: 'user', id: testUser.id, userId: testUser.id },
        platform: 'gitlab',
        repoFullName: gitLabRepo,
        prNumber: 42,
      },
      'current-gitlab-sha'
    );

    expect(result).toEqual({
      head_sha: 'gitlab-matching-sha',
      session_id: 'agent_other_project',
    });
  });

  it('does not return GitLab context for a GitHub review scope', async () => {
    const result = await findPreviousCompletedReview(
      {
        ...githubReviewScope(),
        repoFullName: gitLabRepo,
      },
      'current-gitlab-sha'
    );
    expect(result).toBeNull();
  });

  it('persists terminal_reason for failed reviews', async () => {
    const id = await createReview('sha-billing');
    await updateCodeReviewStatus(id, 'failed', {
      errorMessage: 'Insufficient credits: add credits to continue',
      terminalReason: 'billing',
    });

    const [review] = await db
      .select({ terminalReason: cloud_agent_code_reviews.terminal_reason })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, id))
      .limit(1);

    expect(review?.terminalReason).toBe('billing');
  });

  it('creates new reviews with agent_version set to v2', async () => {
    const id = await createReview('sha-v2-default');

    const [review] = await db
      .select({ agentVersion: cloud_agent_code_reviews.agent_version })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, id))
      .limit(1);

    expect(review?.agentVersion).toBe('v2');
  });

  it('creates, links, lists, and updates code review attempts', async () => {
    const reviewId = await createReview('sha-attempts');
    const firstAttempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'running',
      sessionId: 'agent_attempt_1',
      cliSessionId: 'ses_attempt_1',
    });
    const secondAttempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      retryOfAttemptId: firstAttempt.id,
      retryReason: 'infra_failure',
      status: 'pending',
    });

    expect(firstAttempt.attempt_number).toBe(1);
    expect(secondAttempt.attempt_number).toBe(2);
    expect(secondAttempt.retry_of_attempt_id).toBe(firstAttempt.id);

    const attempts = await listCodeReviewAttempts(reviewId);
    expect(attempts.map(attempt => attempt.attempt_number)).toEqual([1, 2]);

    await updateCodeReviewAttemptForCallback({
      codeReviewId: reviewId,
      status: 'failed',
      sessionId: 'agent_attempt_1',
      errorMessage: 'Container shutdown: SIGTERM',
      terminalReason: 'sandbox_error',
    });

    const [updatedFirstAttempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, firstAttempt.id))
      .limit(1);

    expect(updatedFirstAttempt?.status).toBe('failed');
    expect(updatedFirstAttempt?.error_message).toBe('Container shutdown: SIGTERM');
  });

  it('does not reopen a terminal attempt without session ids', async () => {
    const reviewId = await createReview('sha-terminal-attempt');
    const failedAttempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'failed',
      errorMessage: 'startup failed',
      terminalReason: 'sandbox_error',
    });

    const result = await updateCodeReviewAttemptForCallback({
      codeReviewId: reviewId,
      status: 'running',
      sessionId: 'agent_late',
      cliSessionId: 'ses_late',
      executionId: 'exec_late',
    });

    expect(result.id).toBe(failedAttempt.id);
    expect(result.status).toBe('failed');
    expect(result.session_id).toBeNull();
    expect(result.cli_session_id).toBeNull();
    expect(result.execution_id).toBeNull();

    const [storedAttempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, failedAttempt.id))
      .limit(1);

    expect(storedAttempt?.status).toBe('failed');
    expect(storedAttempt?.session_id).toBeNull();
    expect(storedAttempt?.cli_session_id).toBeNull();
    expect(storedAttempt?.execution_id).toBeNull();
  });

  it('creates only one infra retry attempt for the same failed attempt', async () => {
    const reviewId = await createReview('sha-infra-retry');
    await updateCodeReviewStatus(reviewId, 'running', { sessionId: 'agent_failed' });
    const failedAttempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'failed',
      sessionId: 'agent_failed',
      terminalReason: 'sandbox_error',
    });

    const first = await createInfraRetryAttemptIfMissing({
      codeReviewId: reviewId,
      retryOfAttemptId: failedAttempt.id,
    });
    const second = await createInfraRetryAttemptIfMissing({
      codeReviewId: reviewId,
      retryOfAttemptId: failedAttempt.id,
    });

    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('existing-for-attempt');
    if (first.outcome !== 'created' || second.outcome !== 'existing-for-attempt') {
      throw new Error('Expected created retry followed by existing retry');
    }
    expect(second.attempt.id).toBe(first.attempt.id);

    const attempts = await listCodeReviewAttempts(reviewId);
    expect(attempts.filter(attempt => attempt.retry_reason === 'infra_failure')).toHaveLength(1);
  });

  it('does not create an infra retry attempt for a superseded review', async () => {
    const reviewId = await createReview('sha-superseded-retry');
    const failedAttempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'failed',
      terminalReason: 'sandbox_error',
    });
    await updateCodeReviewStatus(reviewId, 'cancelled', {
      terminalReason: 'superseded',
      errorMessage: 'Superseded by new push',
    });

    const result = await createInfraRetryAttemptIfMissing({
      codeReviewId: reviewId,
      retryOfAttemptId: failedAttempt.id,
    });

    expect(result).toEqual({
      outcome: 'skipped-inactive',
      reviewStatus: 'cancelled',
      terminalReason: 'superseded',
    });

    const attempts = await listCodeReviewAttempts(reviewId);
    expect(attempts.filter(attempt => attempt.retry_reason === 'infra_failure')).toHaveLength(0);
  });

  it('updates an explicit nonterminal historical attempt without changing a newer attempt', async () => {
    const reviewId = await createReview('sha-explicit-attempt');
    const firstAttempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'running',
      sessionId: 'agent-first',
    });
    const newerAttempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      retryOfAttemptId: firstAttempt.id,
      retryReason: 'manual_retrigger',
      status: 'running',
      sessionId: 'agent-second',
    });

    await updateCodeReviewAttemptForCallback({
      codeReviewId: reviewId,
      attemptId: firstAttempt.id,
      status: 'cancelled',
      errorMessage: 'superseded callback',
    });

    const updatedFirst = await getCodeReviewAttemptForReview(reviewId, firstAttempt.id);
    const unchangedLatest = await getCodeReviewAttemptForReview(reviewId, newerAttempt.id);

    expect(updatedFirst?.status).toBe('cancelled');
    expect(updatedFirst?.error_message).toBe('superseded callback');
    expect(unchangedLatest?.status).toBe('running');
  });

  it('throws for an explicit missing attempt id', async () => {
    const reviewId = await createReview('sha-missing-explicit-attempt');
    await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'running',
      sessionId: 'agent-existing',
    });

    await expect(
      updateCodeReviewAttemptForCallback({
        codeReviewId: reviewId,
        attemptId: '00000000-0000-0000-0000-000000000999',
        status: 'failed',
        errorMessage: 'bad callback',
      })
    ).rejects.toThrow('not found');
  });

  it('snapshots analytics enrollment once for a dispatched attempt', async () => {
    const reviewId = await createReview('sha-analytics-snapshot');
    const [review] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId));

    const enabledAttempt = await ensureCurrentCodeReviewAttemptFromReview(review, true);
    const unchangedAttempt = await ensureCurrentCodeReviewAttemptFromReview(review, false);

    expect(enabledAttempt.analytics_enabled_at_dispatch).toBe(true);
    expect(unchangedAttempt.id).toBe(enabledAttempt.id);
    expect(unchangedAttempt.analytics_enabled_at_dispatch).toBe(true);
  });

  it('copies analytics enrollment to an infrastructure retry attempt', async () => {
    const reviewId = await createReview('sha-analytics-retry-snapshot');
    await updateCodeReviewStatus(reviewId, 'running');
    const failedAttempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'failed',
      analyticsEnabledAtDispatch: true,
    });

    const result = await createInfraRetryAttemptIfMissing({
      codeReviewId: reviewId,
      retryOfAttemptId: failedAttempt.id,
    });

    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('Expected infrastructure retry attempt');
    expect(result.attempt.analytics_enabled_at_dispatch).toBe(true);
  });
});

describe('reviewer attempt affinity', () => {
  let user: User;
  const reviewIds: string[] = [];

  beforeAll(async () => {
    user = await insertTestUser({ id: `oauth/github/affinity-${crypto.randomUUID()}` });
  });

  afterAll(async () => {
    if (reviewIds.length)
      await db
        .delete(cloud_agent_code_reviews)
        .where(inArray(cloud_agent_code_reviews.id, reviewIds));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, user.id));
  });

  async function reservedReview() {
    const reservation = crypto.randomUUID();
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_user_id: user.id,
        repo_full_name: 'affinity/repo',
        pr_number: 42,
        pr_url: 'https://github.com/affinity/repo/pull/42',
        pr_title: 'Affinity fixture',
        pr_author: 'author',
        base_ref: 'main',
        head_ref: 'feature',
        head_sha: 'a'.repeat(40),
        status: 'queued',
        dispatch_reservation_id: reservation,
      })
      .returning();
    reviewIds.push(review.id);
    return { codeReviewId: review.id, dispatchReservationId: reservation };
  }

  it('admits one unselected attempt concurrently and pins execution with selection', async () => {
    const reserved = await reservedReview();
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        admitCodeReviewAttemptForDispatch({ ...reserved, previousStatus: 'pending' })
      )
    );
    expect(new Set(attempts.map(attempt => attempt.id)).size).toBe(1);
    expect(attempts[0].reviewer_backend).toBe('unselected');
    expect(attempts[0].reviewer_execution_id).toBeNull();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.transaction(tx =>
          pinCodeReviewAttemptReviewer(tx, {
            ...reserved,
            attemptId: attempts[0].id,
            backend: 'legacy',
          })
        )
      )
    );
    expect(results.filter(result => result.selected)).toHaveLength(1);
    for (const { attempt } of results) {
      expect(attempt.reviewer_backend).toBe('legacy');
      expect(attempt.reviewer_execution_id).toBe(attempt.id);
      expect(attempt.reviewer_selected_at).not.toBeNull();
    }
    const changed = await db.transaction(tx =>
      pinCodeReviewAttemptReviewer(tx, {
        ...reserved,
        attemptId: attempts[0].id,
        backend: 'isolate',
      })
    );
    expect(changed.selected).toBe(false);
    expect(changed.attempt.reviewer_backend).toBe('legacy');
  });

  it.each([true, false])(
    'retains explicit legacy affinity for the one infrastructure retry (selected source: %s)',
    async selected => {
      const reserved = await reservedReview();
      const source = await createCodeReviewAttempt({
        codeReviewId: reserved.codeReviewId,
        status: 'failed',
        terminalReason: 'sandbox_error',
        analyticsEnabledAtDispatch: true,
      });
      if (selected)
        await db
          .update(cloud_agent_code_review_attempts)
          .set({
            reviewer_execution_id: source.id,
            reviewer_selected_at: '2026-04-29 01:16:12.945+00',
          })
          .where(eq(cloud_agent_code_review_attempts.id, source.id));
      const original = await getCodeReviewAttemptForReview(reserved.codeReviewId, source.id);
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          createInfraRetryAttemptIfMissing({
            codeReviewId: reserved.codeReviewId,
            retryOfAttemptId: source.id,
          })
        )
      );
      const created = results.find(result => result.outcome === 'created');
      if (!created || created.outcome !== 'created') throw new Error('Expected a created retry');
      expect(results.filter(result => result.outcome === 'created')).toHaveLength(1);
      expect(results.filter(result => result.outcome === 'existing-for-attempt')).toHaveLength(2);
      expect(created.attempt).toMatchObject({
        reviewer_backend: 'legacy',
        reviewer_execution_id: created.attempt.id,
        reviewer_selected_at: expect.any(String),
        analytics_enabled_at_dispatch: true,
        retry_of_attempt_id: source.id,
        retry_reason: 'infra_failure',
        status: 'pending',
        session_id: null,
        cli_session_id: null,
        execution_id: null,
      });
      expect(created.attempt.id).not.toBe(source.id);
      expect(new Date(created.attempt.reviewer_selected_at ?? '').getTime()).toBeGreaterThan(
        Date.parse('2026-04-29T01:16:12.945Z')
      );
      expect(await getCodeReviewAttemptForReview(reserved.codeReviewId, source.id)).toEqual(
        original
      );
      const reselection = await db.transaction(tx =>
        pinCodeReviewAttemptReviewer(tx, {
          ...reserved,
          attemptId: created.attempt.id,
          backend: 'isolate',
        })
      );
      expect(reselection).toEqual({ selected: false, attempt: created.attempt });
      const anotherSource = await createCodeReviewAttempt({
        codeReviewId: reserved.codeReviewId,
        status: 'failed',
      });
      expect(
        await createInfraRetryAttemptIfMissing({
          codeReviewId: reserved.codeReviewId,
          retryOfAttemptId: anotherSource.id,
        })
      ).toEqual({
        outcome: 'existing-for-review',
        attempt: created.attempt,
      });
    }
  );

  it.each(['unselected', 'isolate'] as const)(
    'rejects infrastructure retries from %s affinity',
    async backend => {
      const reserved = await reservedReview();
      const source = await createCodeReviewAttempt({
        codeReviewId: reserved.codeReviewId,
        status: 'failed',
      });
      await db
        .update(cloud_agent_code_review_attempts)
        .set({
          reviewer_backend: backend,
          reviewer_execution_id: backend === 'isolate' ? source.id : null,
          reviewer_selected_at: backend === 'isolate' ? '2026-04-29 01:16:12.945+00' : null,
        })
        .where(eq(cloud_agent_code_review_attempts.id, source.id));
      const before = await listCodeReviewAttempts(reserved.codeReviewId);

      await expect(
        createInfraRetryAttemptIfMissing({
          codeReviewId: reserved.codeReviewId,
          retryOfAttemptId: source.id,
        })
      ).rejects.toThrow('legacy attempt affinity');
      expect(await listCodeReviewAttempts(reserved.codeReviewId)).toEqual(before);
    }
  );

  it('reads attempt metadata without selecting or returning publication state', async () => {
    const reserved = await reservedReview();
    const attempt = await admitCodeReviewAttemptForDispatch({
      ...reserved,
      previousStatus: 'pending',
    });
    const unrelated = await reservedReview();
    const { publication_state: _publicationState, ...metadata } = attempt;
    const select = jest.spyOn(db, 'select');
    try {
      expect(await listCodeReviewAttempts(reserved.codeReviewId)).toEqual([metadata]);
      expect(
        await getCodeReviewAttemptMetadataForReview(reserved.codeReviewId, attempt.id)
      ).toEqual(metadata);
      expect(
        await getCodeReviewAttemptMetadataForReview(unrelated.codeReviewId, attempt.id)
      ).toBeNull();
      expect(select).toHaveBeenCalledTimes(3);
      for (const [columns] of select.mock.calls) {
        expect(columns).toBeDefined();
        expect(columns).not.toHaveProperty('publication_state');
        expect(columns).toHaveProperty('id', cloud_agent_code_review_attempts.id);
      }
    } finally {
      select.mockRestore();
    }
    expect(await getCodeReviewAttemptForReview(reserved.codeReviewId, attempt.id)).toEqual(attempt);
  });

  it('retains historical queued affinity and the pre-reservation status without metadata', async () => {
    const reserved = await reservedReview();
    const attempt = await admitCodeReviewAttemptForDispatch({
      ...reserved,
      previousStatus: 'queued',
    });
    expect(attempt.status).toBe('queued');
    expect(attempt.reviewer_backend).toBe('legacy');
    expect(attempt.reviewer_execution_id).toBeNull();
    const later = await admitCodeReviewAttemptForDispatch({
      ...reserved,
      previousStatus: 'pending',
    });
    expect(later).toEqual(attempt);
    const selected = await db.transaction(tx =>
      pinCodeReviewAttemptReviewer(tx, { ...reserved, attemptId: attempt.id, backend: 'isolate' })
    );
    expect(selected.attempt).toEqual(attempt);
  });

  it('keeps existing and reconstructed executing attempts legacy', async () => {
    const reserved = await reservedReview();
    const historical = await createCodeReviewAttempt({
      codeReviewId: reserved.codeReviewId,
      status: 'running',
      executionId: 'legacy-execution',
    });
    const unchanged = await admitCodeReviewAttemptForDispatch({
      ...reserved,
      previousStatus: 'pending',
    });
    expect(unchanged.id).toBe(historical.id);
    expect(unchanged.reviewer_backend).toBe('legacy');
    const another = await reservedReview();
    await db
      .update(cloud_agent_code_reviews)
      .set({ session_id: 'agent_old', started_at: '2026-04-29 01:16:12.945+00' })
      .where(eq(cloud_agent_code_reviews.id, another.codeReviewId));
    const recovered = await admitCodeReviewAttemptForDispatch({
      ...another,
      previousStatus: 'queued',
    });
    expect(recovered.reviewer_backend).toBe('legacy');
    expect(recovered.session_id).toBe('agent_old');
    expect(new Date(recovered.started_at ?? '').toISOString()).toBe('2026-04-29T01:16:12.945Z');
  });

  it('fails only the reserved current attempt and preserves historical and unrelated attempts', async () => {
    const reserved = await reservedReview();
    const historical = await admitCodeReviewAttemptForDispatch({
      ...reserved,
      previousStatus: 'pending',
    });
    const current = await createCodeReviewAttempt({ codeReviewId: reserved.codeReviewId });
    const unrelated = await reservedReview();
    const unrelatedAttempt = await admitCodeReviewAttemptForDispatch({
      ...unrelated,
      previousStatus: 'pending',
    });

    expect(
      await failReservedQueuedReview(
        reserved.codeReviewId,
        reserved.dispatchReservationId,
        'Preparation failed',
        'abandoned',
        current.id
      )
    ).toBe(true);
    expect(await getCodeReviewAttemptForReview(reserved.codeReviewId, current.id)).toMatchObject({
      status: 'failed',
      error_message: 'Preparation failed',
      terminal_reason: 'abandoned',
      completed_at: expect.any(String),
    });
    expect(await getCodeReviewAttemptForReview(reserved.codeReviewId, historical.id)).toEqual(
      historical
    );
    expect(
      await getCodeReviewAttemptForReview(unrelated.codeReviewId, unrelatedAttempt.id)
    ).toEqual(unrelatedAttempt);
  });

  it.each([
    { status: 'running' as const },
    { status: 'completed' as const },
    { status: 'queued' as const, sessionId: 'agent_existing' },
  ])('does not fail an executing or terminal reserved attempt: %j', async fields => {
    const reserved = await reservedReview();
    const attempt = await createCodeReviewAttempt({
      codeReviewId: reserved.codeReviewId,
      ...fields,
    });
    expect(
      await failReservedQueuedReview(
        reserved.codeReviewId,
        reserved.dispatchReservationId,
        'Preparation failed',
        undefined,
        attempt.id
      )
    ).toBe(false);
    expect(await getCodeReviewAttemptForReview(reserved.codeReviewId, attempt.id)).toEqual(attempt);
    expect(
      await db.query.cloud_agent_code_reviews.findFirst({
        where: eq(cloud_agent_code_reviews.id, reserved.codeReviewId),
      })
    ).toMatchObject({ status: 'queued', dispatch_reservation_id: reserved.dispatchReservationId });
  });

  it('does not let a stale reservation or attempt fail its successor', async () => {
    const reserved = await reservedReview();
    const attempt = await admitCodeReviewAttemptForDispatch({
      ...reserved,
      previousStatus: 'pending',
    });
    expect(
      await failReservedQueuedReview(
        reserved.codeReviewId,
        crypto.randomUUID(),
        'Preparation failed',
        undefined,
        attempt.id
      )
    ).toBe(false);
    const successor = await createCodeReviewAttempt({ codeReviewId: reserved.codeReviewId });
    expect(
      await failReservedQueuedReview(
        reserved.codeReviewId,
        reserved.dispatchReservationId,
        'Preparation failed',
        undefined,
        attempt.id
      )
    ).toBe(false);
    expect(await getCodeReviewAttemptForReview(reserved.codeReviewId, attempt.id)).toEqual(attempt);
    expect(await getCodeReviewAttemptForReview(reserved.codeReviewId, successor.id)).toEqual(
      successor
    );
    expect(
      await db.query.cloud_agent_code_reviews.findFirst({
        where: eq(cloud_agent_code_reviews.id, reserved.codeReviewId),
      })
    ).toMatchObject({ status: 'queued', dispatch_reservation_id: reserved.dispatchReservationId });
  });

  it('rejects stale reservations and superseded attempts without pinning', async () => {
    const reserved = await reservedReview();
    const attempt = await admitCodeReviewAttemptForDispatch({
      ...reserved,
      previousStatus: 'pending',
    });
    await expect(
      db.transaction(tx =>
        pinCodeReviewAttemptReviewer(tx, {
          ...reserved,
          dispatchReservationId: 'wrong',
          attemptId: attempt.id,
          backend: 'legacy',
        })
      )
    ).rejects.toThrow('reservation changed');
    await createCodeReviewAttempt({ codeReviewId: reserved.codeReviewId });
    await expect(
      db.transaction(tx =>
        pinCodeReviewAttemptReviewer(tx, { ...reserved, attemptId: attempt.id, backend: 'legacy' })
      )
    ).rejects.toThrow('not current');
    expect(
      (await getCodeReviewAttemptForReview(reserved.codeReviewId, attempt.id))?.reviewer_backend
    ).toBe('unselected');
  });
});

describe('getSessionUsageFromBilling', () => {
  const usageIds: string[] = [];

  afterEach(async () => {
    if (usageIds.length === 0) return;

    await db
      .delete(microdollar_usage_metadata)
      .where(inArray(microdollar_usage_metadata.id, usageIds));
    await db.delete(microdollar_usage).where(inArray(microdollar_usage.id, usageIds));
    usageIds.length = 0;
  });

  it('excludes later usage when a completed review session is reused', async () => {
    const sessionId = `ses_usage_window_${crypto.randomUUID()}`;
    const firstUsageId = crypto.randomUUID();
    const laterUsageId = crypto.randomUUID();
    usageIds.push(firstUsageId, laterUsageId);

    await db.insert(microdollar_usage).values([
      {
        id: firstUsageId,
        kilo_user_id: 'code-review-usage-test',
        cost: 100,
        input_tokens: 1000,
        output_tokens: 100,
        cache_write_tokens: 100,
        cache_hit_tokens: 600,
        created_at: '2026-06-18T10:00:00.000Z',
        model: 'anthropic/claude-sonnet-4.6',
      },
      {
        id: laterUsageId,
        kilo_user_id: 'code-review-usage-test',
        cost: 200,
        input_tokens: 2000,
        output_tokens: 200,
        cache_write_tokens: 200,
        cache_hit_tokens: 1200,
        created_at: '2026-06-18T12:00:00.000Z',
        model: 'openai/gpt-4o',
      },
    ]);
    await db.insert(microdollar_usage_metadata).values([
      {
        id: firstUsageId,
        message_id: `msg_${firstUsageId}`,
        session_id: sessionId,
        created_at: '2026-06-18T10:00:00.000Z',
      },
      {
        id: laterUsageId,
        message_id: `msg_${laterUsageId}`,
        session_id: sessionId,
        created_at: '2026-06-18T12:00:00.000Z',
      },
    ]);

    await expect(
      getSessionUsageFromBilling(sessionId, '2026-06-18T09:00:00.000Z', '2026-06-18T11:00:00.000Z')
    ).resolves.toEqual({
      model: 'anthropic/claude-sonnet-4.6',
      totalTokensIn: 1000,
      totalTokensOut: 100,
      tokensIn: 300,
      tokensOut: 100,
      cachedTokens: 700,
      totalCostMusd: 100,
    });
  });
});

describe('code review cancellation and callback guards', () => {
  let user: User;
  const reviewIds: string[] = [];

  beforeAll(async () => {
    user = await insertTestUser({ id: `oauth/github/cancellation-${crypto.randomUUID()}` });
  });

  afterEach(async () => {
    if (reviewIds.length)
      await db
        .delete(cloud_agent_code_reviews)
        .where(inArray(cloud_agent_code_reviews.id, reviewIds));
    reviewIds.length = 0;
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, user.id));
  });

  async function queuedReview(
    overrides: Partial<typeof cloud_agent_code_reviews.$inferInsert> = {}
  ) {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_user_id: user.id,
        repo_full_name: REPO,
        pr_number: 42,
        pr_url: `https://github.com/${REPO}/pull/42`,
        pr_title: 'Cancellation fixture',
        pr_author: 'author',
        base_ref: 'main',
        head_ref: 'feature',
        head_sha: crypto.randomUUID(),
        status: 'queued',
        dispatch_reservation_id: crypto.randomUUID(),
        trigger_source: 'manual',
        updated_at: '2026-04-29 01:16:12.945+00',
        ...overrides,
      })
      .returning();
    reviewIds.push(review.id);
    await admitCodeReviewLedgerRow({
      reviewId: review.id,
      userId: user.id,
      triggerSource: review.trigger_source,
    });
    return review;
  }

  async function readState(reviewId: string) {
    const review = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, reviewId),
    });
    const ledger = await db.query.operation_ledgers.findFirst({
      where: eq(operation_ledgers.operation_key, `review:${reviewId}`),
    });
    const attempts = await listCodeReviewAttempts(reviewId);
    return { review, ledger, attempts };
  }

  async function waitForBlockedCallback(lockingPid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { rows } = await db.execute<{ waiting: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND ${lockingPid}::integer = ANY(pg_blocking_pids(pid))
        ) AS waiting
      `);
      if (rows[0]?.waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Callback did not wait on the expected row lock');
  }

  it.each(['pending', 'queued'] as const)(
    'atomically cancels the current %s legacy attempt once and releases its reservation',
    async status => {
      const review = await queuedReview({
        status,
        total_tokens_in: 0,
        total_tokens_out: 0,
        total_cost_musd: 0,
      });
      const historical = await createCodeReviewAttempt({
        codeReviewId: review.id,
        status: 'completed',
        sessionId: 'agent-old',
      });
      const current = await createCodeReviewAttempt({ codeReviewId: review.id, status });
      const unrelated = await queuedReview();
      await createCodeReviewAttempt({ codeReviewId: unrelated.id, status: 'queued' });
      const unrelatedBefore = await readState(unrelated.id);
      const expected = { attemptId: current.id, updatedAt: '2026-04-29 01:16:12.945+00' };

      const results = await Promise.all(
        Array.from({ length: 3 }, () => cancelCodeReview(review.id, expected))
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      const stored = await readState(review.id);
      expect(stored.review).toMatchObject({
        status: 'cancelled',
        completed_at: expect.any(String),
        dispatch_reservation_id: null,
        session_id: null,
        cli_session_id: null,
        total_tokens_in: 0,
        total_tokens_out: 0,
        total_cost_musd: 0,
      });
      expect(stored.attempts[1]).toMatchObject({
        id: current.id,
        status: 'cancelled',
        completed_at: stored.review?.completed_at,
        updated_at: stored.review?.updated_at,
        reviewer_backend: 'legacy',
      });
      expect(stored.ledger).toMatchObject({ status: 'no_op', kilo_user_id: user.id });
      expect(await getCodeReviewAttemptForReview(review.id, historical.id)).toEqual(historical);
      expect(await readState(unrelated.id)).toEqual(unrelatedBefore);
      expect(await cancelCodeReview(review.id, expected)).toBe(false);
      expect(await readState(review.id)).toEqual(stored);
    }
  );

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'preserves a %s parent and its attempt',
    async status => {
      const review = await queuedReview({ status });
      await createCodeReviewAttempt({ codeReviewId: review.id, status: 'queued' });
      const before = await readState(review.id);

      expect(await cancelCodeReview(review.id)).toBe(false);
      expect(await prepareCodeReviewCancellation(review.id)).toBeNull();
      expect(await readState(review.id)).toEqual(before);
    }
  );

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'preserves a %s latest attempt under an active parent',
    async status => {
      const review = await queuedReview();
      await createCodeReviewAttempt({ codeReviewId: review.id, status });
      const before = await readState(review.id);

      expect(await cancelCodeReview(review.id)).toBe(false);
      expect(await prepareCodeReviewCancellation(review.id)).toBeNull();
      expect(await readState(review.id)).toEqual(before);
    }
  );

  it.each<{
    name: string;
    review?: Partial<typeof cloud_agent_code_reviews.$inferInsert>;
    attempt?: Partial<typeof cloud_agent_code_review_attempts.$inferInsert>;
  }>([
    { name: 'parent session', review: { session_id: 'agent-started' } },
    { name: 'parent CLI session', review: { cli_session_id: 'ses-started' } },
    { name: 'parent start', review: { started_at: '2026-04-29 01:16:12.945+00' } },
    { name: 'parent usage', review: { total_tokens_in: 1 } },
    { name: 'attempt session', attempt: { session_id: 'agent-started' } },
    { name: 'attempt CLI session', attempt: { cli_session_id: 'ses-started' } },
    { name: 'attempt execution', attempt: { execution_id: 'exec-started' } },
    { name: 'running attempt', attempt: { status: 'running' } },
  ])('does not locally cancel started work: $name', async fields => {
    const review = await queuedReview(fields.review);
    const current = await createCodeReviewAttempt({ codeReviewId: review.id, status: 'queued' });
    if (fields.attempt)
      await db
        .update(cloud_agent_code_review_attempts)
        .set(fields.attempt)
        .where(eq(cloud_agent_code_review_attempts.id, current.id));
    const before = await readState(review.id);

    expect(
      await cancelCodeReview(review.id, { attemptId: current.id, updatedAt: review.updated_at })
    ).toBe(false);
    expect(await readState(review.id)).toEqual(before);
  });

  it.each([true, false])(
    'rejects a successor admitted after preparation (previous attempt: %s)',
    async existing => {
      const review = await queuedReview();
      const previous = existing
        ? await createCodeReviewAttempt({ codeReviewId: review.id, status: 'queued' })
        : null;
      const current = await createCodeReviewAttempt({ codeReviewId: review.id, status: 'queued' });
      const before = await readState(review.id);

      expect(
        await cancelCodeReview(review.id, {
          attemptId: previous?.id ?? null,
          updatedAt: review.updated_at,
        })
      ).toBe(false);
      expect(await readState(review.id)).toEqual(before);
      expect(await getCodeReviewAttemptForReview(review.id, current.id)).toEqual(current);
    }
  );

  it('rejects a stale parent snapshot after a reservation changes', async () => {
    const review = await queuedReview();
    const current = await createCodeReviewAttempt({ codeReviewId: review.id, status: 'queued' });
    await db
      .update(cloud_agent_code_reviews)
      .set({ dispatch_reservation_id: crypto.randomUUID() })
      .where(eq(cloud_agent_code_reviews.id, review.id));
    const before = await readState(review.id);

    expect(
      await cancelCodeReview(review.id, { attemptId: current.id, updatedAt: review.updated_at })
    ).toBe(false);
    expect(await readState(review.id)).toEqual(before);
  });

  it('does not use the local legacy fallback for a pinned isolate attempt', async () => {
    const review = await queuedReview();
    const attemptId = crypto.randomUUID();
    await db.insert(cloud_agent_code_review_attempts).values({
      id: attemptId,
      code_review_id: review.id,
      attempt_number: 1,
      status: 'queued',
      reviewer_backend: 'isolate',
      reviewer_execution_id: attemptId,
      reviewer_selected_at: '2026-04-29 01:16:12.945+00',
    });
    const before = await readState(review.id);

    expect(await cancelCodeReview(review.id)).toBe(false);
    expect(await cancelCodeReview(review.id, { attemptId, updatedAt: review.updated_at })).toBe(
      false
    );
    expect(await readState(review.id)).toEqual(before);
  });

  it.each([
    ['running', true],
    ['completed', true],
    ['running', false],
    ['completed', false],
  ] as const)(
    'preserves cancellation after a late %s callback (explicit ID: %s)',
    async (status, explicit) => {
      const review = await queuedReview();
      const attempt = await createCodeReviewAttempt({ codeReviewId: review.id, status: 'queued' });
      expect(
        await cancelCodeReview(review.id, { attemptId: attempt.id, updatedAt: review.updated_at })
      ).toBe(true);
      const cancelled = await getCodeReviewAttemptForReview(review.id, attempt.id);
      const state = await readState(review.id);

      const identified = await updateCodeReviewAttemptForCallback({
        codeReviewId: review.id,
        attemptId: attempt.id,
        status: 'running',
        sessionId: 'agent-late',
      });
      expect(identified).toEqual({
        ...cancelled,
        session_id: 'agent-late',
        updated_at: expect.any(String),
      });
      const payload = {
        codeReviewId: review.id,
        attemptId: explicit ? attempt.id : undefined,
        status,
        sessionId: 'agent-late',
        cliSessionId: 'ses-late',
        executionId: 'exec-late',
        errorMessage: 'Late failure metadata',
        terminalReason: 'sandbox_error' as const,
        startedAt: new Date('2026-05-01T01:00:00Z'),
        completedAt: new Date('2026-05-01T02:00:00Z'),
      };
      const updated = await updateCodeReviewAttemptForCallback(payload);
      expect(updated).toEqual({
        ...identified,
        cli_session_id: 'ses-late',
        execution_id: 'exec-late',
        updated_at: expect.any(String),
      });
      expect(updated.status).toBe('cancelled');
      expect(await updateCodeReviewAttemptForCallback(payload)).toEqual(updated);
      const after = await readState(review.id);
      expect(after.review).toEqual(state.review);
      expect(after.ledger).toEqual(state.ledger);
    }
  );

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'retains the %s outcome of explicit and session-matched historical callbacks',
    async status => {
      const review = await queuedReview();
      const source = await createCodeReviewAttempt({
        codeReviewId: review.id,
        status,
        sessionId: 'agent-old',
        cliSessionId: 'ses-old',
        executionId: 'exec-old',
        terminalReason: 'sandbox_error',
        errorMessage: 'Original terminal error',
      });
      const latest = await createCodeReviewAttempt({
        codeReviewId: review.id,
        status: 'queued',
        sessionId: 'agent-new',
      });
      for (const attemptId of [source.id, undefined]) {
        expect(
          await updateCodeReviewAttemptForCallback({
            codeReviewId: review.id,
            attemptId,
            status: 'completed',
            sessionId: 'agent-old',
            cliSessionId: 'ses-old',
            executionId: 'exec-old',
            terminalReason: 'abandoned',
            errorMessage: 'Replacement error',
            completedAt: new Date('2026-05-01T02:00:00Z'),
          })
        ).toEqual(source);
      }
      expect(await getCodeReviewAttemptForReview(review.id, latest.id)).toEqual(latest);
    }
  );

  it.each(['sessionId', 'cliSessionId', 'executionId'] as const)(
    'does not mix late accounting IDs with an established different %s',
    async field => {
      const review = await queuedReview();
      const attempt = await createCodeReviewAttempt({
        codeReviewId: review.id,
        status: 'cancelled',
        [field]: 'retained-identity',
      });
      expect(
        await updateCodeReviewAttemptForCallback({
          codeReviewId: review.id,
          attemptId: attempt.id,
          status: 'completed',
          sessionId: 'agent-late',
          cliSessionId: 'ses-late',
          executionId: 'exec-late',
        })
      ).toEqual(attempt);
      expect(await getCodeReviewAttemptForReview(review.id, attempt.id)).toEqual(attempt);
    }
  );

  it('keeps the historical running callback field filter for active attempts', async () => {
    const review = await queuedReview();
    const source = await createCodeReviewAttempt({ codeReviewId: review.id, status: 'pending' });
    const result = await updateCodeReviewAttemptForCallback({
      codeReviewId: review.id,
      status: 'running',
      sessionId: 'agent-running',
      cliSessionId: 'ses-running',
      executionId: 'exec-running',
      errorMessage: 'Unused running error',
      terminalReason: 'abandoned',
      startedAt: new Date('2026-04-29 01:16:12.945+00'),
      completedAt: new Date('2026-04-29 02:16:12.945+00'),
    });
    expect(result).toMatchObject({
      id: source.id,
      status: 'running',
      session_id: 'agent-running',
      cli_session_id: 'ses-running',
      execution_id: 'exec-running',
      error_message: null,
      terminal_reason: null,
      completed_at: null,
    });
    expect(new Date(result.started_at ?? '').toISOString()).not.toBe('2026-04-29T01:16:12.945Z');
  });

  it('preserves terminal outcomes while completing CLI-session-matched accounting metadata', async () => {
    const review = await queuedReview();
    const attempt = await createCodeReviewAttempt({
      codeReviewId: review.id,
      status: 'failed',
      cliSessionId: 'ses-retained',
    });
    const updated = await updateCodeReviewAttemptForCallback({
      codeReviewId: review.id,
      status: 'completed',
      cliSessionId: 'ses-retained',
      sessionId: 'agent-late',
      executionId: 'exec-late',
    });
    expect(updated).toEqual({
      ...attempt,
      session_id: 'agent-late',
      execution_id: 'exec-late',
      updated_at: expect.any(String),
    });
  });

  it('allows matching completion redelivery to recover a still-active parent', async () => {
    const review = await queuedReview();
    const source = await createCodeReviewAttempt({ codeReviewId: review.id, status: 'queued' });
    const completed = await updateCodeReviewAttemptForCallback({
      codeReviewId: review.id,
      attemptId: source.id,
      status: 'completed',
      sessionId: 'agent-completed',
      cliSessionId: 'ses-completed',
      completedAt: new Date('2026-04-29 02:16:12.945+00'),
    });
    expect(
      await updateCodeReviewAttemptForCallback({
        codeReviewId: review.id,
        attemptId: source.id,
        status: 'completed',
        completedAt: new Date('2026-05-01T02:00:00Z'),
      })
    ).toEqual(completed);
    expect(
      await updateCodeReviewStatusIfNonTerminal(
        review.id,
        'completed',
        {
          sessionId: completed.session_id ?? undefined,
          cliSessionId: completed.cli_session_id ?? undefined,
          completedAt: new Date(completed.completed_at ?? ''),
        },
        undefined,
        source.id
      )
    ).toBe(true);
    expect((await readState(review.id)).review).toMatchObject({
      status: 'completed',
      completed_at: completed.completed_at,
    });
  });

  it('rechecks a terminal attempt after waiting for cancellation to commit', async () => {
    const review = await queuedReview();
    const source = await createCodeReviewAttempt({ codeReviewId: review.id, status: 'queued' });
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const terminalFields = {
      status: 'cancelled',
      terminal_reason: 'user_cancelled',
      error_message: 'Cancelled first',
      completed_at: '2026-04-29 02:16:12.945+00',
    };
    const cancellation = db.transaction(async tx => {
      await tx
        .select({ id: cloud_agent_code_reviews.id })
        .from(cloud_agent_code_reviews)
        .where(eq(cloud_agent_code_reviews.id, review.id))
        .for('update');
      await tx
        .update(cloud_agent_code_reviews)
        .set(terminalFields)
        .where(eq(cloud_agent_code_reviews.id, review.id));
      await tx
        .update(cloud_agent_code_review_attempts)
        .set(terminalFields)
        .where(eq(cloud_agent_code_review_attempts.id, source.id));
      const { rows } = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      locked.resolve(rows[0].pid);
      await release.promise;
    });
    void cancellation.catch(locked.reject);
    let callback: ReturnType<typeof updateCodeReviewAttemptForCallback> | undefined;
    try {
      const lockingPid = await locked.promise;
      callback = updateCodeReviewAttemptForCallback({
        codeReviewId: review.id,
        attemptId: source.id,
        status: 'running',
        sessionId: 'agent-late',
        errorMessage: 'Replacement error',
        terminalReason: 'abandoned',
        completedAt: new Date('2026-05-01T02:00:00Z'),
      });
      await waitForBlockedCallback(lockingPid);
      release.resolve();
      const result = await callback;
      expect(result).toMatchObject({
        status: 'cancelled',
        terminal_reason: 'user_cancelled',
        error_message: 'Cancelled first',
        session_id: 'agent-late',
      });
      expect(new Date(result.completed_at ?? '').toISOString()).toBe('2026-04-29T02:16:12.945Z');
    } finally {
      release.resolve();
      await cancellation;
      await callback;
    }
  }, 15_000);

  it('preserves the fourth-position reservation guard without requiring an attempt', async () => {
    const review = await queuedReview();
    expect(
      await updateCodeReviewStatusIfNonTerminal(review.id, 'running', {}, crypto.randomUUID())
    ).toBe(false);
    expect(
      await updateCodeReviewStatusIfNonTerminal(
        review.id,
        'running',
        {},
        review.dispatch_reservation_id ?? undefined
      )
    ).toBe(true);
    expect((await readState(review.id)).review?.status).toBe('running');
  });

  it('requires the latest local attempt and the reservation when both guards are supplied', async () => {
    const review = await queuedReview();
    const old = await createCodeReviewAttempt({ codeReviewId: review.id, status: 'queued' });
    const current = await createCodeReviewAttempt({ codeReviewId: review.id, status: 'queued' });
    const unrelated = await queuedReview();
    const foreign = await createCodeReviewAttempt({ codeReviewId: unrelated.id, status: 'queued' });
    const before = await readState(review.id);
    for (const attemptId of [old.id, foreign.id, crypto.randomUUID()]) {
      expect(
        await updateCodeReviewStatusIfNonTerminal(review.id, 'running', {}, undefined, attemptId)
      ).toBe(false);
    }
    expect(
      await updateCodeReviewStatusIfNonTerminal(
        review.id,
        'running',
        {},
        crypto.randomUUID(),
        current.id
      )
    ).toBe(false);
    expect(await readState(review.id)).toEqual(before);
    expect(
      await updateCodeReviewStatusIfNonTerminal(
        review.id,
        'running',
        { sessionId: 'agent-current' },
        review.dispatch_reservation_id ?? undefined,
        current.id
      )
    ).toBe(true);
    expect((await readState(review.id)).review).toMatchObject({
      status: 'running',
      session_id: 'agent-current',
    });
  });

  it('does not fall back when the expected attempt or parent does not exist', async () => {
    const review = await queuedReview();
    const before = await readState(review.id);
    expect(
      await updateCodeReviewStatusIfNonTerminal(
        review.id,
        'running',
        {},
        undefined,
        crypto.randomUUID()
      )
    ).toBe(false);
    expect(
      await updateCodeReviewStatusIfNonTerminal(
        crypto.randomUUID(),
        'running',
        {},
        undefined,
        crypto.randomUUID()
      )
    ).toBe(false);
    expect(await readState(review.id)).toEqual(before);
  });

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'does not change a %s parent with a matching expected attempt',
    async status => {
      const review = await queuedReview({ status });
      const source = await createCodeReviewAttempt({ codeReviewId: review.id, status: 'queued' });
      const before = await readState(review.id);
      expect(
        await updateCodeReviewStatusIfNonTerminal(
          review.id,
          'running',
          { sessionId: 'agent-late' },
          undefined,
          source.id
        )
      ).toBe(false);
      expect(await readState(review.id)).toEqual(before);
    }
  );

  it('allows an allocated failed retry, but not its source, to terminalize the parent', async () => {
    const review = await queuedReview();
    const source = await createCodeReviewAttempt({ codeReviewId: review.id, status: 'failed' });
    const retry = await createInfraRetryAttemptIfMissing({
      codeReviewId: review.id,
      retryOfAttemptId: source.id,
    });
    if (retry.outcome !== 'created') throw new Error('Expected an allocated retry');
    await updateCodeReviewAttemptForCallback({
      codeReviewId: review.id,
      attemptId: retry.attempt.id,
      status: 'failed',
      errorMessage: 'Retry startup failed',
    });
    expect(
      await updateCodeReviewStatusIfNonTerminal(
        review.id,
        'failed',
        { errorMessage: 'Old failure' },
        undefined,
        source.id
      )
    ).toBe(false);
    expect(
      await updateCodeReviewStatusIfNonTerminal(
        review.id,
        'failed',
        { errorMessage: 'Retry startup failed' },
        undefined,
        retry.attempt.id
      )
    ).toBe(true);
    expect((await readState(review.id)).review).toMatchObject({
      status: 'failed',
      error_message: 'Retry startup failed',
    });
  });

  it('reads the latest attempt after a parent lock wait instead of using a stale subquery snapshot', async () => {
    const review = await queuedReview();
    const source = await createCodeReviewAttempt({ codeReviewId: review.id, status: 'queued' });
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const successorId = crypto.randomUUID();
    const successor = db.transaction(async tx => {
      await tx
        .select({ id: cloud_agent_code_reviews.id })
        .from(cloud_agent_code_reviews)
        .where(eq(cloud_agent_code_reviews.id, review.id))
        .for('update');
      await tx.insert(cloud_agent_code_review_attempts).values({
        id: successorId,
        code_review_id: review.id,
        attempt_number: 2,
        status: 'queued',
      });
      const { rows } = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      locked.resolve(rows[0].pid);
      await release.promise;
    });
    void successor.catch(locked.reject);
    let callback: Promise<boolean> | undefined;
    try {
      const lockingPid = await locked.promise;
      callback = updateCodeReviewStatusIfNonTerminal(
        review.id,
        'failed',
        { errorMessage: 'Stale callback' },
        undefined,
        source.id
      );
      await waitForBlockedCallback(lockingPid);
      release.resolve();
      expect(await callback).toBe(false);
      expect((await readState(review.id)).review).toEqual(review);
      expect(await getCodeReviewAttemptForReview(review.id, successorId)).toMatchObject({
        status: 'queued',
      });
    } finally {
      release.resolve();
      await successor;
      await callback;
    }
  }, 15_000);
});

describe('resetCodeReviewForRetry', () => {
  let testUser: User;
  const reviewIds: string[] = [];

  beforeAll(async () => {
    testUser = await insertTestUser({ id: `oauth/github/retry-${crypto.randomUUID()}` });
  });

  afterEach(async () => {
    if (reviewIds.length === 0) return;
    await db
      .delete(cloud_agent_code_reviews)
      .where(inArray(cloud_agent_code_reviews.id, reviewIds));
    reviewIds.length = 0;
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function insertReview(status: string, overrides: Record<string, unknown> = {}) {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_user_id: testUser.id,
        repo_full_name: REPO,
        pr_number: 1,
        pr_url: `https://github.com/${REPO}/pull/1`,
        pr_title: 'Test PR',
        pr_author: 'octocat',
        base_ref: 'main',
        head_ref: 'feature/test',
        head_sha: `sha-${crypto.randomUUID()}`,
        status,
        ...overrides,
      })
      .returning({ id: cloud_agent_code_reviews.id });
    reviewIds.push(review.id);
    return review.id;
  }

  it('resets a failed review and returns 1', async () => {
    const reviewId = await insertReview('failed', {
      session_id: 'agent-first',
      error_message: 'Container shutdown: SIGTERM',
      terminal_reason: 'sandbox_error',
    });

    const count = await resetCodeReviewForRetry(reviewId);

    expect(count).toBe(1);

    const stored = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, reviewId),
    });
    expect(stored?.status).toBe('pending');
    expect(stored?.session_id).toBeNull();
    expect(stored?.error_message).toBeNull();
  });

  it.each(['pending', 'queued', 'running'] as const)(
    'reconstructs the terminal parent on its %s legacy attempt before retriggering',
    async status => {
      const reviewId = await insertReview('cancelled', {
        session_id: 'agent-current',
        cli_session_id: 'ses-current',
        error_message: 'Cancelled by user',
        terminal_reason: 'user_cancelled',
        started_at: '2026-04-29 01:16:12.945+00',
        completed_at: '2026-04-29 02:16:12.945+00',
        updated_at: '2026-04-29 02:16:12.945+00',
      });
      const historical = await createCodeReviewAttempt({
        codeReviewId: reviewId,
        status: 'failed',
        sessionId: 'agent-old',
      });
      const source = await createCodeReviewAttempt({
        codeReviewId: reviewId,
        status,
        executionId: 'exec-current',
      });

      expect(
        await resetCodeReviewForRetry(reviewId, {
          attemptId: source.id,
          updatedAt: '2026-04-29 02:16:12.945+00',
        })
      ).toBe(1);

      const reconstructed = await getCodeReviewAttemptForReview(reviewId, source.id);
      expect(reconstructed).toMatchObject({
        status: 'cancelled',
        terminal_reason: 'user_cancelled',
        error_message: 'Cancelled by user',
        session_id: 'agent-current',
        cli_session_id: 'ses-current',
        execution_id: 'exec-current',
        reviewer_backend: 'legacy',
      });
      expect(new Date(reconstructed?.started_at ?? '').toISOString()).toBe(
        '2026-04-29T01:16:12.945Z'
      );
      expect(new Date(reconstructed?.completed_at ?? '').toISOString()).toBe(
        '2026-04-29T02:16:12.945Z'
      );
      expect(await getCodeReviewAttemptForReview(reviewId, historical.id)).toEqual(historical);
      const attempts = await listCodeReviewAttempts(reviewId);
      expect(attempts).toHaveLength(3);
      expect(attempts[2]).toMatchObject({
        status: 'pending',
        retry_of_attempt_id: source.id,
        retry_reason: 'manual_retrigger',
        reviewer_backend: 'unselected',
        reviewer_execution_id: null,
        reviewer_selected_at: null,
        session_id: null,
        cli_session_id: null,
        started_at: null,
        completed_at: null,
      });
    }
  );

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'does not rewrite a terminal %s source attempt during retrigger',
    async status => {
      const reviewId = await insertReview('failed', { terminal_reason: 'sandbox_error' });
      const source = await createCodeReviewAttempt({
        codeReviewId: reviewId,
        status,
        sessionId: 'agent-old',
      });

      expect(await resetCodeReviewForRetry(reviewId, { attemptId: source.id })).toBe(1);

      expect(await getCodeReviewAttemptForReview(reviewId, source.id)).toEqual(source);
      expect(await listCodeReviewAttempts(reviewId)).toHaveLength(2);
    }
  );

  it('returns 0 for a review that is not in a retriggable terminal state', async () => {
    const reviewId = await insertReview('pending');

    const count = await resetCodeReviewForRetry(reviewId);

    expect(count).toBe(0);

    const stored = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, reviewId),
    });
    expect(stored?.status).toBe('pending');
  });

  it('persists sanitized previous summaries while preserving null and valid markdown', async () => {
    const reviewId = await insertReview('pending');

    await updatePreviousReviewSummary(reviewId, {
      body: '## Summary\nactual\0NUL, literal \\u0000, and 😀',
      headSha: 'previous-head-sha',
    });

    const stored = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, reviewId),
    });
    expect(stored?.previous_summary_body).toBe(
      '## Summary\nactual\ufffdNUL, literal \\u0000, and 😀'
    );
    expect(stored?.previous_summary_head_sha).toBe('previous-head-sha');

    await updatePreviousReviewSummary(reviewId, { body: null, headSha: null });

    const cleared = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, reviewId),
    });
    expect(cleared?.previous_summary_body).toBeNull();
    expect(cleared?.previous_summary_head_sha).toBeNull();
  });

  it('marks a reserved review failed when its dispatch error contains a NUL character', async () => {
    const reservationId = crypto.randomUUID();
    const reviewId = await insertReview('queued', {
      dispatch_reservation_id: reservationId,
    });

    await expect(
      failReservedQueuedReview(reviewId, reservationId, 'Dispatch failed: actual\0NUL')
    ).resolves.toBe(true);

    const stored = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, reviewId),
    });
    expect(stored?.status).toBe('failed');
    expect(stored?.dispatch_reservation_id).toBeNull();
    expect(stored?.error_message).toBe('Dispatch failed: actual\ufffdNUL');
  });
});

describe('listCodeReviews narrows the list DTO', () => {
  let testUser: User;
  let integrationId: string;
  const createdReviewIds: string[] = [];

  beforeAll(async () => {
    testUser = await insertTestUser();
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: testUser.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: `narrow-list-${Date.now()}`,
        platform_account_id: 'narrow-list',
        platform_account_login: 'narrow-list',
        repository_access: 'all',
        integration_status: 'active',
      })
      .returning({ id: platform_integrations.id });
    if (!integration) {
      throw new Error('Expected narrow-list integration');
    }
    integrationId = integration.id;
  });

  afterAll(async () => {
    for (const id of createdReviewIds) {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, id));
    }
    await db.delete(platform_integrations).where(eq(platform_integrations.id, integrationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function createReviewWithHeavyFields() {
    const reviewId = await createCodeReview({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      platformIntegrationId: integrationId,
      repoFullName: `${REPO}-narrow-list`,
      prNumber: 61,
      prUrl: `https://github.com/${REPO}-narrow-list/pull/61`,
      prTitle: 'narrow list DTO',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/narrow-list',
      headSha: 'narrow-list-head-sha',
      platform: 'github',
    });
    createdReviewIds.push(reviewId);
    await db
      .update(cloud_agent_code_reviews)
      .set({
        council_result: {
          decision: 'pass',
          aggregationStrategy: 'unanimous',
          specialists: [],
        } as CodeReviewCouncilResult,
        manual_config: {
          outputMode: 'kilo',
          instructions: null,
          agentConfig: { model_slug: 'test-model' },
        } as ManualCodeReviewConfig,
        previous_summary_body: 'previous summary body',
      })
      .where(eq(cloud_agent_code_reviews.id, reviewId));
    return reviewId;
  }

  it('omits council_result, manual_config, and previous_summary_body from list rows', async () => {
    const reviewId = await createReviewWithHeavyFields();

    const rows = await listCodeReviews({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      limit: 50,
      offset: 0,
    });

    const row = rows.find(r => r.id === reviewId);
    expect(row).toBeDefined();
    if (!row) {
      throw new Error('Expected narrow-list row');
    }
    expect(row).not.toHaveProperty('council_result');
    expect(row).not.toHaveProperty('manual_config');
    expect(row).not.toHaveProperty('previous_summary_body');
    expect(row).not.toHaveProperty('blocked_by_attempt_id');

    const {
      council_result: _councilResult,
      manual_config: _manualConfig,
      previous_summary_body: _previousSummaryBody,
      blocked_by_attempt_id: _blockedByAttemptId,
      ...listColumns
    } = getTableColumns(cloud_agent_code_reviews);
    expect(Object.keys(row).sort()).toEqual(Object.keys(listColumns).sort());
  });

  it('keeps council_result available to the detail getter', async () => {
    const reviewId = await createReviewWithHeavyFields();

    const councilResult = await getCodeReviewCouncilResult(reviewId);

    expect(councilResult).toEqual({
      decision: 'pass',
      aggregationStrategy: 'unanimous',
      specialists: [],
    });
  });
});
