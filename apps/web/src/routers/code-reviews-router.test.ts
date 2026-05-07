const mockCancelReview = jest.fn();

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    cancelReview: (...args: unknown[]) => mockCancelReview(...args),
  },
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  createCheckRun: jest.fn(),
  updateCheckRun: jest.fn(),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  setCommitStatus: jest.fn(),
}));

import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { cloud_agent_code_reviews, kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

const REPO = `test-org/code-reviews-cancel-${Date.now()}`;
type ReviewStatus = 'pending' | 'queued' | 'running';
type CodeReviewInsert = typeof cloud_agent_code_reviews.$inferInsert;

function reviewValues(
  userId: string,
  status: ReviewStatus,
  overrides: Partial<CodeReviewInsert> = {}
) {
  const idSuffix = crypto.randomUUID();
  return {
    owned_by_user_id: userId,
    owned_by_organization_id: null,
    platform_integration_id: null,
    check_run_id: null,
    repo_full_name: REPO,
    pr_number: 1,
    pr_url: `https://github.com/${REPO}/pull/1`,
    pr_title: 'Test PR',
    pr_author: 'octocat',
    base_ref: 'main',
    head_ref: `feature/${idSuffix}`,
    head_sha: `sha-${idSuffix}`,
    status,
    agent_version: 'v2',
    ...overrides,
  } satisfies CodeReviewInsert;
}

describe('codeReviewRouter.cancel', () => {
  let testUser: User;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  beforeEach(() => {
    mockCancelReview.mockResolvedValue({ success: true, reviewId: 'unused' });
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
    mockCancelReview.mockReset();
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  it('locally cancels a queued review without a session when the Worker returns false', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(reviewValues(testUser.id, 'queued'))
      .returning({ id: cloud_agent_code_reviews.id });
    mockCancelReview.mockResolvedValue({ success: false, reviewId: review.id });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.codeReviews.cancel({ reviewId: review.id });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(result.success).toBe(true);
    expect(mockCancelReview).toHaveBeenCalledWith(review.id, 'Cancelled by user');
    expect(storedReview?.status).toBe('cancelled');
    expect(storedReview?.completed_at).toBeTruthy();
  });

  it('cancels pending reviews locally without calling the Worker', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(reviewValues(testUser.id, 'pending'))
      .returning({ id: cloud_agent_code_reviews.id });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.codeReviews.cancel({ reviewId: review.id });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(result.success).toBe(true);
    expect(mockCancelReview).not.toHaveBeenCalled();
    expect(storedReview?.status).toBe('cancelled');
    expect(storedReview?.completed_at).toBeTruthy();
  });

  it('locally cancels a queued review without a session when the Worker throws', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(reviewValues(testUser.id, 'queued'))
      .returning({ id: cloud_agent_code_reviews.id });
    mockCancelReview.mockRejectedValue(new Error('Request timeout after 10000ms'));

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.codeReviews.cancel({ reviewId: review.id });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(result.success).toBe(true);
    expect(mockCancelReview).toHaveBeenCalledWith(review.id, 'Cancelled by user');
    expect(storedReview?.status).toBe('cancelled');
    expect(storedReview?.completed_at).toBeTruthy();
  });

  it('does not claim success for queued reviews with a session when the Worker returns false', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(reviewValues(testUser.id, 'queued', { session_id: 'agent-session-1' }))
      .returning({ id: cloud_agent_code_reviews.id });
    mockCancelReview.mockResolvedValue({ success: false, reviewId: review.id });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.codeReviews.cancel({ reviewId: review.id });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(result).toEqual({ success: false, error: 'Worker could not cancel code review' });
    expect(storedReview?.status).toBe('queued');
    expect(storedReview?.completed_at).toBeNull();
  });

  it('does not locally cancel queued reviews with a session when the Worker throws', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(reviewValues(testUser.id, 'queued', { session_id: 'agent-session-1' }))
      .returning({ id: cloud_agent_code_reviews.id });
    mockCancelReview.mockRejectedValue(new Error('Request timeout after 10000ms'));

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.codeReviews.cancel({ reviewId: review.id });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(result).toEqual({ success: false, error: 'Worker could not cancel code review' });
    expect(storedReview?.status).toBe('queued');
    expect(storedReview?.completed_at).toBeNull();
  });

  it('does not locally cancel running reviews when the Worker throws', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(reviewValues(testUser.id, 'running', { session_id: 'agent-session-1' }))
      .returning({ id: cloud_agent_code_reviews.id });
    mockCancelReview.mockRejectedValue(new Error('Request timeout after 10000ms'));

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.codeReviews.cancel({ reviewId: review.id });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(result).toEqual({ success: false, error: 'Worker could not cancel code review' });
    expect(storedReview?.status).toBe('running');
    expect(storedReview?.completed_at).toBeNull();
  });
});
