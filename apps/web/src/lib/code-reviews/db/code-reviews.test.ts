import { db } from '@/lib/drizzle';
import { cloud_agent_code_reviews, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import {
  createCodeReview,
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
});
