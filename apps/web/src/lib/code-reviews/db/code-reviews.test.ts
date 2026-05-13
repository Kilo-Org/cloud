import { db } from '@/lib/drizzle';
import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import {
  createCodeReview,
  createCodeReviewAttempt,
  createInfraRetryAttemptIfMissing,
  getCodeReviewAttemptForReview,
  listCodeReviewAttempts,
  updateCodeReviewAttemptForCallback,
  updateCodeReviewStatus,
  findPreviousCompletedReview,
} from './code-reviews';

const REPO = `test-org/session-continuation-${Date.now()}`;

describe('findPreviousCompletedReview', () => {
  let testUser: User;
  const createdReviewIds: string[] = [];

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  afterAll(async () => {
    for (const id of createdReviewIds) {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, id));
    }
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
    expect(second.attempt.id).toBe(first.attempt.id);

    const attempts = await listCodeReviewAttempts(reviewId);
    expect(attempts.filter(attempt => attempt.retry_reason === 'infra_failure')).toHaveLength(1);
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
