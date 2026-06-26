import { db } from '@/lib/drizzle';
import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import type { Organization, User } from '@kilocode/db/schema';
import type { ManualCodeReviewConfig } from '@kilocode/db/schema-types';
import {
  cancelSupersededReviewsForPR,
  createCodeReview,
  createCodeReviewAttempt,
  createInfraRetryAttemptIfMissing,
  ensureCurrentCodeReviewAttemptFromReview,
  getCodeReviewAttemptForReview,
  getSessionUsageFromBilling,
  listCodeReviewAttempts,
  updateCodeReviewAttemptForCallback,
  findPreviousCompletedReview,
  updateCodeReviewStatus,
} from './code-reviews';

const REPO = `test-org/session-continuation-${Date.now()}`;

describe('cancelSupersededReviewsForPR', () => {
  let testUser: User;
  let githubIntegrationId: string;
  let gitLabIntegrationId: string;
  const createdReviewIds: string[] = [];
  const repo = `${REPO}-superseded`;

  beforeAll(async () => {
    testUser = await insertTestUser();
    const [githubIntegration, gitLabIntegration] = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_user_id: testUser.id,
          platform: 'github',
          integration_type: 'github_app',
          platform_installation_id: `github-superseded-${Date.now()}-${Math.random()}`,
          platform_account_id: 'github-superseded',
          platform_account_login: 'github-superseded',
          repository_access: 'all',
          integration_status: 'active',
        },
        {
          owned_by_user_id: testUser.id,
          platform: 'gitlab',
          integration_type: 'oauth',
          platform_installation_id: `gitlab-superseded-${Date.now()}-${Math.random()}`,
          platform_account_id: 'gitlab-superseded',
          platform_account_login: 'gitlab-superseded',
          repository_access: 'all',
          integration_status: 'active',
        },
      ])
      .returning({ id: platform_integrations.id });
    if (!githubIntegration || !gitLabIntegration) {
      throw new Error('Expected platform integrations');
    }
    githubIntegrationId = githubIntegration.id;
    gitLabIntegrationId = gitLabIntegration.id;
  });

  afterAll(async () => {
    for (const id of createdReviewIds) {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, id));
    }
    await db
      .delete(platform_integrations)
      .where(inArray(platform_integrations.id, [githubIntegrationId, gitLabIntegrationId]));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function createReview({
    headSha,
    prNumber = 42,
    repoFullName = repo,
    platform = 'github' as const,
    platformProjectId,
    platformIntegrationId,
  }: {
    headSha: string;
    prNumber?: number;
    repoFullName?: string;
    platform?: 'github' | 'gitlab';
    platformProjectId?: number;
    platformIntegrationId?: string;
  }) {
    const resolvedPlatformIntegrationId =
      platformIntegrationId ?? (platform === 'gitlab' ? gitLabIntegrationId : githubIntegrationId);
    const id = await createCodeReview({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      platformIntegrationId: resolvedPlatformIntegrationId,
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

  it('cancels pending, queued, and running rows and returns accurate prev_status values', async () => {
    const pendingId = await createReview({ headSha: 'sha-pending' });
    const queuedId = await createReview({ headSha: 'sha-queued', prNumber: 43 });
    const runningId = await createReview({ headSha: 'sha-running', prNumber: 44 });
    const pendingAttempt = await createCodeReviewAttempt({
      codeReviewId: pendingId,
      status: 'pending',
    });
    const runningAttempt = await createCodeReviewAttempt({
      codeReviewId: runningId,
      status: 'running',
      sessionId: 'session-running',
    });

    await updateCodeReviewStatus(queuedId, 'queued');
    await updateCodeReviewStatus(runningId, 'running', { sessionId: 'session-running' });

    const cancelled = [
      ...(await cancelSupersededReviewsForPR(repo, 42, 'sha-latest', {
        platformIntegrationId: githubIntegrationId,
      })),
      ...(await cancelSupersededReviewsForPR(repo, 43, 'sha-latest', {
        platformIntegrationId: githubIntegrationId,
      })),
      ...(await cancelSupersededReviewsForPR(repo, 44, 'sha-latest', {
        platformIntegrationId: githubIntegrationId,
      })),
    ];

    expect(cancelled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pendingId, prevStatus: 'pending', headSha: 'sha-pending' }),
        expect.objectContaining({ id: queuedId, prevStatus: 'queued', headSha: 'sha-queued' }),
        expect.objectContaining({
          id: runningId,
          prevStatus: 'running',
          headSha: 'sha-running',
          sessionId: 'session-running',
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
        completedAt: cloud_agent_code_reviews.completed_at,
        startedAt: cloud_agent_code_reviews.started_at,
        sessionId: cloud_agent_code_reviews.session_id,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, repo));

    for (const row of rows.filter(row => [pendingId, queuedId, runningId].includes(row.id))) {
      expect(row.status).toBe('cancelled');
      expect(row.terminalReason).toBe('superseded');
      expect(row.errorMessage).toBe('Superseded by new push');
      expect(row.completedAt).not.toBeNull();
    }

    expect(rows.find(row => row.id === pendingId)?.startedAt).toBeNull();
    expect(rows.find(row => row.id === pendingId)?.sessionId).toBeNull();
    expect(rows.find(row => row.id === runningId)?.sessionId).toBe('session-running');

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

    expect(cancelled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pendingId, latestActiveAttemptId: pendingAttempt.id }),
      ])
    );
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

  it('ignores same-sha, different repo or pr, and already-terminal rows; second call is idempotent', async () => {
    const terminalCompletedId = await createReview({ headSha: 'sha-completed' });
    await updateCodeReviewStatus(terminalCompletedId, 'completed');
    const terminalFailedId = await createReview({ headSha: 'sha-failed' });
    await updateCodeReviewStatus(terminalFailedId, 'failed', {
      errorMessage: 'failed before cancel',
    });

    const sameShaId = await createReview({ headSha: 'sha-keep' });
    const otherPrId = await createReview({ headSha: 'sha-other-pr', prNumber: 43 });
    const otherRepoId = await createReview({
      headSha: 'sha-other-repo',
      repoFullName: `${repo}-other`,
    });
    const targetId = await createReview({
      headSha: 'sha-gitlab',
      platform: 'gitlab',
      platformProjectId: 999,
    });

    const cancelled = await cancelSupersededReviewsForPR(repo, 42, 'sha-keep', {
      platformIntegrationId: gitLabIntegrationId,
    });
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toEqual(
      expect.objectContaining({
        id: targetId,
        prevStatus: 'pending',
        headSha: 'sha-gitlab',
        platform: 'gitlab',
        platformProjectId: 999,
        platformIntegrationId: gitLabIntegrationId,
      })
    );

    const cancelledAgain = await cancelSupersededReviewsForPR(repo, 42, 'sha-keep', {
      platformIntegrationId: gitLabIntegrationId,
    });
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

describe('manual Code Reviewer review identity', () => {
  let testUser: User;
  let organization: Organization;
  const createdReviewIds: string[] = [];
  const repo = `${REPO}-manual-identity`;
  const manualConfig: ManualCodeReviewConfig = {
    agentConfig: {
      review_style: 'balanced',
      focus_areas: [],
      model_slug: 'test-model',
    },
    instructions: null,
    outputMode: 'kilo',
  };

  beforeAll(async () => {
    testUser = await insertTestUser();
    organization = await createTestOrganization(
      'Manual Review Identity Org',
      testUser.id,
      0,
      {},
      false
    );
  });

  afterAll(async () => {
    for (const id of createdReviewIds) {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, id));
    }
    await db.delete(organizations).where(eq(organizations.id, organization.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function createManualReview(owner: Parameters<typeof createCodeReview>[0]['owner']) {
    const id = await createCodeReview({
      owner,
      repoFullName: repo,
      prNumber: 1,
      prUrl: `https://github.com/${repo}/pull/1`,
      prTitle: 'Manual PR',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'refs/pull/1/head',
      headSha: 'manual-sha',
      platform: 'github',
      manualConfig,
    });
    createdReviewIds.push(id);
    return id;
  }

  it('allows repeated manual rows for the same owner, repo, PR, and SHA', async () => {
    const personalFirstId = await createManualReview({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });
    const personalSecondId = await createManualReview({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });
    const organizationFirstId = await createManualReview({
      type: 'org',
      id: organization.id,
      userId: testUser.id,
    });
    const organizationSecondId = await createManualReview({
      type: 'org',
      id: organization.id,
      userId: testUser.id,
    });

    const rows = await db
      .select({ id: cloud_agent_code_reviews.id })
      .from(cloud_agent_code_reviews)
      .where(
        inArray(cloud_agent_code_reviews.id, [
          personalFirstId,
          personalSecondId,
          organizationFirstId,
          organizationSecondId,
        ])
      );

    expect(new Set(rows.map(row => row.id))).toEqual(
      new Set([personalFirstId, personalSecondId, organizationFirstId, organizationSecondId])
    );
  });
});

describe('findPreviousCompletedReview', () => {
  let testUser: User;
  let githubIntegrationId: string;
  let gitLabIntegrationAId: string;
  let gitLabIntegrationBId: string;
  const createdReviewIds: string[] = [];
  const gitLabRepo = `${REPO}-gitlab-scope`;
  let auxiliaryPrNumber = 1_000;

  beforeAll(async () => {
    testUser = await insertTestUser();
    const [githubIntegration, gitLabIntegrationA, gitLabIntegrationB] = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_user_id: testUser.id,
          platform: 'github',
          integration_type: 'github_app',
          platform_installation_id: `github-continuation-${Date.now()}-${Math.random()}`,
          platform_account_id: 'github-continuation',
          platform_account_login: 'github-continuation',
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
      throw new Error('Expected platform integrations');
    }
    githubIntegrationId = githubIntegration.id;
    gitLabIntegrationAId = gitLabIntegrationA.id;
    gitLabIntegrationBId = gitLabIntegrationB.id;
  });

  afterAll(async () => {
    for (const id of createdReviewIds) {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, id));
    }
    await db.delete(platform_integrations).where(eq(platform_integrations.id, githubIntegrationId));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.id, gitLabIntegrationAId));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.id, gitLabIntegrationBId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function createReview(headSha: string, prNumber = 42) {
    const id = await createCodeReview({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      repoFullName: REPO,
      prNumber,
      prUrl: `https://github.com/${REPO}/pull/${prNumber}`,
      prTitle: 'test PR',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/test',
      headSha,
      platform: 'github',
      platformIntegrationId: githubIntegrationId,
    });
    createdReviewIds.push(id);
    return id;
  }

  async function createAuxiliaryReview(headSha: string) {
    const prNumber = auxiliaryPrNumber++;
    return await createReview(headSha, prNumber);
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

  function githubContinuationScope() {
    return { platform: 'github' as const, integrationId: githubIntegrationId };
  }

  it('returns null when no previous completed review exists', async () => {
    const result = await findPreviousCompletedReview(REPO, 42, 'abc123', githubContinuationScope());
    expect(result).toBeNull();
  });

  it('returns head_sha and session_id: null for a completed review without session', async () => {
    const id = await createReview('sha-no-session');
    await updateCodeReviewStatus(id, 'completed');

    const result = await findPreviousCompletedReview(
      REPO,
      42,
      'other-sha',
      githubContinuationScope()
    );
    expect(result).not.toBeNull();
    expect(result!.head_sha).toBe('sha-no-session');
    expect(result!.session_id).toBeNull();
  });

  it('returns head_sha and session_id for a completed review with session', async () => {
    const id = await createReview('sha-with-session');
    await updateCodeReviewStatus(id, 'completed', {
      sessionId: 'agent_test123',
    });

    const result = await findPreviousCompletedReview(
      REPO,
      42,
      'other-sha',
      githubContinuationScope()
    );
    expect(result).not.toBeNull();
    expect(result!.head_sha).toBe('sha-with-session');
    expect(result!.session_id).toBe('agent_test123');
  });

  it('excludes the current SHA', async () => {
    const result = await findPreviousCompletedReview(
      REPO,
      42,
      'sha-with-session',
      githubContinuationScope()
    );
    // Should skip "sha-with-session" and fall back to "sha-no-session"
    expect(result).not.toBeNull();
    expect(result!.head_sha).toBe('sha-no-session');
  });

  it('returns the most recent completed review', async () => {
    const id = await createReview('sha-newer');
    await updateCodeReviewStatus(id, 'completed', {
      sessionId: 'agent_newer',
    });

    const result = await findPreviousCompletedReview(
      REPO,
      42,
      'other-sha',
      githubContinuationScope()
    );
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
    const result = await findPreviousCompletedReview(
      REPO,
      42,
      'other-sha',
      githubContinuationScope()
    );
    expect(result).not.toBeNull();
    expect(result!.head_sha).not.toBe('sha-running');

    await updateCodeReviewStatus(id, 'cancelled', {
      terminalReason: 'superseded',
      errorMessage: 'test cleanup',
    });
  });

  it('ensures session_id and head_sha come from the same row', async () => {
    // Create a completed review with no session (simulates v1 legacy)
    const legacyId = await createReview('sha-legacy-newest');
    await updateCodeReviewStatus(legacyId, 'completed');

    const result = await findPreviousCompletedReview(
      REPO,
      42,
      'other-sha',
      githubContinuationScope()
    );
    expect(result).not.toBeNull();
    // The newest completed review has no session — both fields from same row
    expect(result!.head_sha).toBe('sha-legacy-newest');
    expect(result!.session_id).toBeNull();
  });

  it('scopes GitLab session continuation to the exact integration and project', async () => {
    const matchingId = await createGitLabReview('gitlab-matching-sha', gitLabIntegrationAId, 501);
    await updateCodeReviewStatus(matchingId, 'completed', { sessionId: 'agent_matching_gitlab' });
    const differentIntegrationId = await createGitLabReview(
      'gitlab-other-integration-sha',
      gitLabIntegrationBId,
      501
    );
    await updateCodeReviewStatus(differentIntegrationId, 'completed', {
      sessionId: 'agent_other_integration',
    });
    const differentProjectId = await createGitLabReview(
      'gitlab-other-project-sha',
      gitLabIntegrationAId,
      502
    );
    await updateCodeReviewStatus(differentProjectId, 'completed', {
      sessionId: 'agent_other_project',
    });

    const result = await findPreviousCompletedReview(gitLabRepo, 42, 'current-gitlab-sha', {
      platform: 'gitlab',
      integrationId: gitLabIntegrationAId,
      projectId: 501,
    });

    expect(result).toEqual({
      head_sha: 'gitlab-matching-sha',
      session_id: 'agent_matching_gitlab',
    });
  });

  it('does not share GitLab reviews with a GitHub continuation scope', async () => {
    const result = await findPreviousCompletedReview(
      gitLabRepo,
      42,
      'current-gitlab-sha',
      githubContinuationScope()
    );
    expect(result).toBeNull();
  });

  it('persists terminal_reason for failed reviews', async () => {
    const id = await createAuxiliaryReview('sha-billing');
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
    const id = await createAuxiliaryReview('sha-v2-default');

    const [review] = await db
      .select({ agentVersion: cloud_agent_code_reviews.agent_version })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, id))
      .limit(1);

    expect(review?.agentVersion).toBe('v2');
  });

  it('creates, links, lists, and updates code review attempts', async () => {
    const reviewId = await createAuxiliaryReview('sha-attempts');
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
    const reviewId = await createAuxiliaryReview('sha-terminal-attempt');
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
    const reviewId = await createAuxiliaryReview('sha-infra-retry');
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
    const reviewId = await createAuxiliaryReview('sha-superseded-retry');
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
    const reviewId = await createAuxiliaryReview('sha-explicit-attempt');
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
    const reviewId = await createAuxiliaryReview('sha-missing-explicit-attempt');
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
    const reviewId = await createAuxiliaryReview('sha-analytics-snapshot');
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
    const reviewId = await createAuxiliaryReview('sha-analytics-retry-snapshot');
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
