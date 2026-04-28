import { db } from '@/lib/drizzle';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { cloud_agent_code_reviews, kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { prepareReviewPayload } from './prepare-review-payload';

const REPO = `test-org/prepare-review-payload-${Date.now()}`;

const codeReviewConfig = {
  review_style: 'balanced',
  focus_areas: ['bugs'],
  custom_instructions: null,
  max_review_time_minutes: 20,
  model_slug: 'anthropic/claude-sonnet-4.5',
  repository_selection_mode: 'all',
  gate_threshold: 'off',
} satisfies CodeReviewAgentConfig;

describe('prepareReviewPayload', () => {
  let testUser: User;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.owned_by_user_id, testUser.id));
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  it('uses the stable GitHub pull ref for agent checkout when the stored head_ref is a branch name', async () => {
    const prNumber = 1234;
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_user_id: testUser.id,
        repo_full_name: REPO,
        pr_number: prNumber,
        pr_url: `https://github.com/${REPO}/pull/${prNumber}`,
        pr_title: 'Test PR with deleted source branch',
        pr_author: 'octocat',
        base_ref: 'main',
        head_ref: 'feature/deleted-after-merge',
        head_sha: 'sha-current',
        platform: 'github',
        status: 'pending',
      })
      .returning({ id: cloud_agent_code_reviews.id });

    if (!review) {
      throw new Error('Expected inserted review');
    }

    const payload = await prepareReviewPayload({
      reviewId: review.id,
      owner: {
        type: 'user',
        id: testUser.id,
        userId: testUser.id,
      },
      agentConfig: {
        config: codeReviewConfig,
      },
      platform: 'github',
    });

    expect(payload.sessionInput).toMatchObject({
      githubRepo: REPO,
      platform: 'github',
      upstreamBranch: 'refs/pull/1234/head',
    });
  });

  it('does not continue previous cloud-agent sessions for GitHub pull-ref reviews', async () => {
    const prNumber = 1235;
    const repo = `${REPO}-session-continuation`;

    await db.insert(cloud_agent_code_reviews).values({
      owned_by_user_id: testUser.id,
      repo_full_name: repo,
      pr_number: prNumber,
      pr_url: `https://github.com/${repo}/pull/${prNumber}`,
      pr_title: 'Previous completed review',
      pr_author: 'octocat',
      base_ref: 'main',
      head_ref: 'feature/old-head',
      head_sha: 'sha-previous',
      platform: 'github',
      status: 'completed',
      session_id: 'previous-cloud-agent-session',
    });

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_user_id: testUser.id,
        repo_full_name: repo,
        pr_number: prNumber,
        pr_url: `https://github.com/${repo}/pull/${prNumber}`,
        pr_title: 'Current review',
        pr_author: 'octocat',
        base_ref: 'main',
        head_ref: 'feature/current-head',
        head_sha: 'sha-current',
        platform: 'github',
        status: 'pending',
      })
      .returning({ id: cloud_agent_code_reviews.id });

    if (!review) {
      throw new Error('Expected inserted review');
    }

    const payload = await prepareReviewPayload({
      reviewId: review.id,
      owner: {
        type: 'user',
        id: testUser.id,
        userId: testUser.id,
      },
      agentConfig: {
        config: codeReviewConfig,
      },
      platform: 'github',
    });

    expect(payload.previousCloudAgentSessionId).toBeUndefined();
    expect(payload.sessionInput).toMatchObject({
      githubRepo: repo,
      platform: 'github',
      upstreamBranch: 'refs/pull/1235/head',
    });
  });
});
