import { db } from '@/lib/drizzle';
import {
  agent_configs,
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import {
  bitbucketCodeReviewerLifecycleLockKey,
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
  getSessionUsageFromBilling,
  listCodeReviewAttempts,
  updateCodeReviewAttemptForCallback,
  findPreviousCompletedReview,
  updateCodeReviewStatus,
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

  it('updates an explicit attempt id even when a newer attempt exists', async () => {
    const reviewId = await createReview('sha-explicit-attempt');
    const firstAttempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'failed',
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
