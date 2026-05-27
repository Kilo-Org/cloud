import { db } from '@/lib/drizzle';
import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import {
  cancelSupersededReviewsForPR,
  createCodeReview,
  createCodeReviewAttempt,
  createInfraRetryAttemptIfMissing,
  getCodeReviewAttemptForReview,
  listCodeReviewAttempts,
  updateCodeReviewAttemptForCallback,
  findPreviousCompletedReview,
  updateCodeReviewStatus,
} from './code-reviews';

const REPO = `test-org/session-continuation-${Date.now()}`;

describe('cancelSupersededReviewsForPR', () => {
  let testUser: User;
  const createdReviewIds: string[] = [];
  const repo = `${REPO}-superseded`;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  afterAll(async () => {
    for (const id of createdReviewIds) {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, id));
    }
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function createReview({
    headSha,
    prNumber = 42,
    repoFullName = repo,
    platform = 'github' as const,
    platformProjectId,
  }: {
    headSha: string;
    prNumber?: number;
    repoFullName?: string;
    platform?: 'github' | 'gitlab';
    platformProjectId?: number;
  }) {
    const id = await createCodeReview({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
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
    const queuedId = await createReview({ headSha: 'sha-queued' });
    const runningId = await createReview({ headSha: 'sha-running' });
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

    const cancelled = await cancelSupersededReviewsForPR(repo, 42, 'sha-latest');

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
    const sameShaId = await createReview({ headSha: 'sha-keep' });
    const otherPrId = await createReview({ headSha: 'sha-other-pr', prNumber: 43 });
    const otherRepoId = await createReview({
      headSha: 'sha-other-repo',
      repoFullName: `${repo}-other`,
    });
    const terminalCompletedId = await createReview({ headSha: 'sha-completed' });
    const terminalFailedId = await createReview({ headSha: 'sha-failed' });
    const targetId = await createReview({
      headSha: 'sha-gitlab',
      platform: 'gitlab',
      platformProjectId: 999,
    });

    await updateCodeReviewStatus(terminalCompletedId, 'completed');
    await updateCodeReviewStatus(terminalFailedId, 'failed', {
      errorMessage: 'failed before cancel',
    });

    const cancelled = await cancelSupersededReviewsForPR(repo, 42, 'sha-keep');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toEqual(
      expect.objectContaining({
        id: targetId,
        prevStatus: 'pending',
        headSha: 'sha-gitlab',
        platform: 'gitlab',
        platformProjectId: 999,
        platformIntegrationId: null,
      })
    );

    const cancelledAgain = await cancelSupersededReviewsForPR(repo, 42, 'sha-keep');
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

describe('findPreviousCompletedReview', () => {
  let testUser: User;
  let gitLabIntegrationAId: string;
  let gitLabIntegrationBId: string;
  const createdReviewIds: string[] = [];
  const gitLabRepo = `${REPO}-gitlab-scope`;

  beforeAll(async () => {
    testUser = await insertTestUser();
    const [gitLabIntegrationA, gitLabIntegrationB] = await db
      .insert(platform_integrations)
      .values([
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
    if (!gitLabIntegrationA || !gitLabIntegrationB) {
      throw new Error('Expected GitLab integrations');
    }
    gitLabIntegrationAId = gitLabIntegrationA.id;
    gitLabIntegrationBId = gitLabIntegrationB.id;
  });

  afterAll(async () => {
    for (const id of createdReviewIds) {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, id));
    }
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.id, gitLabIntegrationAId));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.id, gitLabIntegrationBId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function createReview(headSha: string) {
    const id = await createCodeReview({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
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

  it('returns null when no previous completed review exists', async () => {
    const result = await findPreviousCompletedReview(REPO, 42, 'abc123');
    expect(result).toBeNull();
  });

  it('returns head_sha and session_id: null for a completed review without session', async () => {
    const id = await createReview('sha-no-session');
    await updateCodeReviewStatus(id, 'completed');

    const result = await findPreviousCompletedReview(REPO, 42, 'other-sha');
    expect(result).not.toBeNull();
    expect(result!.head_sha).toBe('sha-no-session');
    expect(result!.session_id).toBeNull();
  });

  it('returns head_sha and session_id for a completed review with session', async () => {
    const id = await createReview('sha-with-session');
    await updateCodeReviewStatus(id, 'completed', {
      sessionId: 'agent_test123',
    });

    const result = await findPreviousCompletedReview(REPO, 42, 'other-sha');
    expect(result).not.toBeNull();
    expect(result!.head_sha).toBe('sha-with-session');
    expect(result!.session_id).toBe('agent_test123');
  });

  it('excludes the current SHA', async () => {
    const result = await findPreviousCompletedReview(REPO, 42, 'sha-with-session');
    // Should skip "sha-with-session" and fall back to "sha-no-session"
    expect(result).not.toBeNull();
    expect(result!.head_sha).toBe('sha-no-session');
  });

  it('returns the most recent completed review', async () => {
    const id = await createReview('sha-newer');
    await updateCodeReviewStatus(id, 'completed', {
      sessionId: 'agent_newer',
    });

    const result = await findPreviousCompletedReview(REPO, 42, 'other-sha');
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
    const result = await findPreviousCompletedReview(REPO, 42, 'other-sha');
    expect(result).not.toBeNull();
    expect(result!.head_sha).toBe('sha-newer');
    expect(result!.session_id).toBe('agent_newer');
  });

  it('ensures session_id and head_sha come from the same row', async () => {
    // Create a completed review with no session (simulates v1 legacy)
    const legacyId = await createReview('sha-legacy-newest');
    await updateCodeReviewStatus(legacyId, 'completed');

    const result = await findPreviousCompletedReview(REPO, 42, 'other-sha');
    expect(result).not.toBeNull();
    // The newest completed review has no session — both fields from same row
    expect(result!.head_sha).toBe('sha-legacy-newest');
    expect(result!.session_id).toBeNull();
  });

  it('scopes GitLab session continuation to the exact integration and project', async () => {
    const matchingId = await createGitLabReview('gitlab-matching-sha', gitLabIntegrationAId, 501);
    const differentIntegrationId = await createGitLabReview(
      'gitlab-other-integration-sha',
      gitLabIntegrationBId,
      501
    );
    const differentProjectId = await createGitLabReview(
      'gitlab-other-project-sha',
      gitLabIntegrationAId,
      502
    );
    await updateCodeReviewStatus(matchingId, 'completed', { sessionId: 'agent_matching_gitlab' });
    await updateCodeReviewStatus(differentIntegrationId, 'completed', {
      sessionId: 'agent_other_integration',
    });
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

  it('uses the default GitHub continuation scope when options are omitted', async () => {
    const result = await findPreviousCompletedReview(gitLabRepo, 42, 'current-gitlab-sha');
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
});
