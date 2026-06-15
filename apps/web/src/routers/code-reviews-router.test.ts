const mockCancelReview = jest.fn();
const mockTryDispatchPendingReviews = jest.fn();

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    cancelReview: (...args: unknown[]) => mockCancelReview(...args),
  },
}));

jest.mock('@/lib/code-reviews/dispatch/dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: (...args: unknown[]) => mockTryDispatchPendingReviews(...args),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  createCheckRun: jest.fn(),
  updateCheckRun: jest.fn(),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  setCommitStatus: jest.fn(),
}));

import { db } from '@/lib/drizzle';
import { updateCheckRun } from '@/lib/integrations/platforms/github/adapter';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import {
  agent_configs,
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  organization_audit_logs,
  organizations,
  platform_integrations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

const REPO = `test-org/code-reviews-cancel-${Date.now()}`;
type ReviewStatus = 'pending' | 'queued' | 'running' | 'failed';
type CodeReviewInsert = typeof cloud_agent_code_reviews.$inferInsert;
const mockUpdateCheckRun = jest.mocked(updateCheckRun);

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

async function insertGitHubIntegration(userId: string, githubAppType: 'standard' | 'lite') {
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: userId,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: `inst-${crypto.randomUUID()}`,
      github_app_type: githubAppType,
    })
    .returning();

  return integration;
}

describe('codeReviewRouter.cancel', () => {
  let testUser: User;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  beforeEach(() => {
    mockCancelReview.mockResolvedValue({ success: true, reviewId: 'unused' });
    mockTryDispatchPendingReviews.mockResolvedValue(undefined);
    mockUpdateCheckRun.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, testUser.id));
    mockCancelReview.mockReset();
    mockTryDispatchPendingReviews.mockReset();
    mockUpdateCheckRun.mockReset();
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
    expect(mockCancelReview).toHaveBeenCalledWith(review.id, 'Cancelled by user', undefined);
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
    expect(mockCancelReview).toHaveBeenCalledWith(review.id, 'Cancelled by user', undefined);
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

  it('passes the integration GitHub app type when cancelling a pending check run', async () => {
    const integration = await insertGitHubIntegration(testUser.id, 'lite');
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues(testUser.id, 'pending', {
          platform_integration_id: integration.id,
          check_run_id: 12345,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });
    const [repoOwner, repoName] = REPO.split('/');

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.codeReviews.cancel({ reviewId: review.id });

    expect(result.success).toBe(true);
    expect(mockUpdateCheckRun).toHaveBeenCalledWith(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      12345,
      expect.objectContaining({ status: 'completed', conclusion: 'cancelled' }),
      'lite'
    );
  });
});

describe('review agent config REVIEW.md setting', () => {
  let testUser: User;
  let organization: Organization;

  beforeAll(async () => {
    testUser = await insertTestUser();
    organization = await createTestOrganization('Review Config Org', testUser.id, 0, {}, false);
  });

  afterEach(async () => {
    await db
      .delete(agent_configs)
      .where(
        and(
          eq(agent_configs.agent_type, 'code_review'),
          eq(agent_configs.platform, 'github'),
          eq(agent_configs.owned_by_user_id, testUser.id)
        )
      );
    await db
      .delete(agent_configs)
      .where(
        and(
          eq(agent_configs.agent_type, 'code_review'),
          eq(agent_configs.platform, 'github'),
          eq(agent_configs.owned_by_organization_id, organization.id)
        )
      );
    await db
      .delete(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id));
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, organization.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  it('returns disableReviewMd true for personal default config', async () => {
    const caller = await createCallerForUser(testUser.id);

    const config = await caller.personalReviewAgent.getReviewConfig({ platform: 'github' });

    expect(config.disableReviewMd).toBe(true);
    expect(config.actionRequired).toBeNull();
  });

  it('returns disableReviewMd true for organization default config', async () => {
    const caller = await createCallerForUser(testUser.id);

    const config = await caller.organizations.reviewAgent.getReviewConfig({
      organizationId: organization.id,
      platform: 'github',
    });

    expect(config.disableReviewMd).toBe(true);
    expect(config.actionRequired).toBeNull();
  });

  it('returns actionRequired runtime state for personal config', async () => {
    const caller = await createCallerForUser(testUser.id);
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'github',
      config: { disable_review_md: true },
      is_enabled: false,
      created_by: testUser.id,
      runtime_state: {
        code_review_action_required: {
          reason: 'byok_invalid_key',
          detectedAt: '2026-05-28T00:00:00.000Z',
          lastSeenAt: '2026-05-28T00:00:00.000Z',
          lastErrorMessage:
            'Code Reviewer was disabled because the selected BYOK API key is invalid or has been revoked. Update the key or choose another model, then enable Code Reviewer again.',
        },
      },
    });

    const config = await caller.personalReviewAgent.getReviewConfig({ platform: 'github' });

    expect(config.isEnabled).toBe(false);
    expect(config.actionRequired).toEqual(expect.objectContaining({ reason: 'byok_invalid_key' }));
  });

  it('preserves disabled state when saving an existing personal config', async () => {
    const caller = await createCallerForUser(testUser.id);
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'github',
      config: { disable_review_md: true },
      is_enabled: false,
      created_by: testUser.id,
    });

    await caller.personalReviewAgent.saveReviewConfig({
      platform: 'github',
      reviewStyle: 'balanced',
      focusAreas: [],
      modelSlug: 'test-model',
      disableReviewMd: true,
    });

    const config = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });

    expect(config?.is_enabled).toBe(false);
  });

  it('clears actionRequired state when toggling personal Code Reviewer', async () => {
    const caller = await createCallerForUser(testUser.id);
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'github',
      config: { disable_review_md: true },
      is_enabled: false,
      created_by: testUser.id,
      runtime_state: {
        code_review_action_required: {
          reason: 'github_installation_required',
          detectedAt: '2026-05-28T00:00:00.000Z',
          lastSeenAt: '2026-05-28T00:00:00.000Z',
          lastErrorMessage:
            'Code Reviewer was disabled because Kilo cannot access this repository with an active GitHub App installation. Update the GitHub App installation, then enable Code Reviewer again.',
        },
      },
    });

    await caller.personalReviewAgent.toggleReviewAgent({ platform: 'github', isEnabled: true });

    const config = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });

    expect(config?.is_enabled).toBe(true);
    expect(JSON.stringify(config?.runtime_state)).not.toContain('code_review_action_required');
  });

  it('persists personal disableReviewMd true as disable_review_md true', async () => {
    const caller = await createCallerForUser(testUser.id);

    await caller.personalReviewAgent.saveReviewConfig({
      platform: 'github',
      reviewStyle: 'balanced',
      focusAreas: [],
      modelSlug: 'test-model',
      disableReviewMd: true,
    });

    const config = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });

    expect(config?.config).toEqual(expect.objectContaining({ disable_review_md: true }));
    expect(config?.config).not.toHaveProperty('max_review_time_minutes');

    const refetched = await caller.personalReviewAgent.getReviewConfig({ platform: 'github' });
    expect(refetched.disableReviewMd).toBe(true);
    expect(refetched).not.toHaveProperty('maxReviewTimeMinutes');
  });

  it('persists organization disableReviewMd true as disable_review_md true', async () => {
    const caller = await createCallerForUser(testUser.id);

    await caller.organizations.reviewAgent.saveReviewConfig({
      organizationId: organization.id,
      platform: 'github',
      reviewStyle: 'balanced',
      focusAreas: [],
      modelSlug: 'test-model',
      disableReviewMd: true,
    });

    const config = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_organization_id, organization.id)
      ),
    });

    expect(config?.config).toEqual(expect.objectContaining({ disable_review_md: true }));
    expect(config?.config).not.toHaveProperty('max_review_time_minutes');

    const refetched = await caller.organizations.reviewAgent.getReviewConfig({
      organizationId: organization.id,
      platform: 'github',
    });
    expect(refetched.disableReviewMd).toBe(true);
    expect(refetched).not.toHaveProperty('maxReviewTimeMinutes');
  });

  it('persists omitted personal disableReviewMd as true by default', async () => {
    const caller = await createCallerForUser(testUser.id);

    await caller.personalReviewAgent.saveReviewConfig({
      platform: 'github',
      reviewStyle: 'balanced',
      focusAreas: [],
      modelSlug: 'test-model',
    });

    const config = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });

    expect(config?.config).toEqual(expect.objectContaining({ disable_review_md: true }));
    expect(config?.config).not.toHaveProperty('max_review_time_minutes');
  });

  it('persists omitted organization disableReviewMd as true by default', async () => {
    const caller = await createCallerForUser(testUser.id);

    await caller.organizations.reviewAgent.saveReviewConfig({
      organizationId: organization.id,
      platform: 'github',
      reviewStyle: 'balanced',
      focusAreas: [],
      modelSlug: 'test-model',
    });

    const config = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_organization_id, organization.id)
      ),
    });

    expect(config?.config).toEqual(expect.objectContaining({ disable_review_md: true }));
    expect(config?.config).not.toHaveProperty('max_review_time_minutes');
  });
});

describe('codeReviewRouter attempts', () => {
  let testUser: User;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
    await db.delete(agent_configs).where(eq(agent_configs.owned_by_user_id, testUser.id));
    mockCancelReview.mockReset();
    mockTryDispatchPendingReviews.mockReset();
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function insertEnabledAgentConfig(runtimeState: Record<string, unknown> = {}) {
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'github',
      config: { disable_review_md: true },
      is_enabled: true,
      runtime_state: runtimeState,
      created_by: testUser.id,
    });
  }

  it('returns attempts from get and preserves history during retrigger', async () => {
    await insertEnabledAgentConfig();
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues(testUser.id, 'running', {
          session_id: 'agent-first',
          cli_session_id: 'ses_first',
          status: 'failed',
          error_message: 'Container shutdown: SIGTERM',
          terminal_reason: 'sandbox_error',
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    const caller = await createCallerForUser(testUser.id);
    const before = await caller.codeReviews.get({ reviewId: review.id });
    expect(before.success).toBe(true);
    expect(before.success ? before.attempts : []).toEqual([]);

    await caller.codeReviews.retrigger({ reviewId: review.id });

    const after = await caller.codeReviews.get({ reviewId: review.id });
    if (!after.success) {
      throw new Error('Expected successful code review get');
    }

    expect(after.attempts).toHaveLength(2);
    expect(after.attempts.map(attempt => attempt.retry_reason)).toEqual([null, 'manual_retrigger']);
    expect(after.attempts[0]?.session_id).toBe('agent-first');

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });
    expect(storedReview?.status).toBe('pending');
    expect(storedReview?.session_id).toBeNull();
  });

  it('retrigger dispatches using the newly created attempt id', async () => {
    await insertEnabledAgentConfig();
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues(testUser.id, 'failed', {
          session_id: 'agent-first',
          cli_session_id: 'ses_first',
          error_message: 'Container shutdown: SIGTERM',
          terminal_reason: 'sandbox_error',
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    const caller = await createCallerForUser(testUser.id);
    await caller.codeReviews.retrigger({ reviewId: review.id });

    const attempts = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id));
    const latestAttempt = attempts.sort((a, b) => b.attempt_number - a.attempt_number)[0];

    expect(latestAttempt?.retry_reason).toBe('manual_retrigger');
    expect(mockTryDispatchPendingReviews).toHaveBeenCalled();
  });

  it('blocks retrigger while Code Reviewer has action-required state', async () => {
    await insertEnabledAgentConfig({
      code_review_action_required: {
        reason: 'byok_invalid_key',
        detectedAt: '2026-05-28T00:00:00.000Z',
        lastSeenAt: '2026-05-28T00:00:00.000Z',
        lastErrorMessage:
          'Code Reviewer was disabled because the selected BYOK API key is invalid or has been revoked. Update the key or choose another model, then enable Code Reviewer again.',
      },
    });
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues(testUser.id, 'failed', {
          session_id: 'agent-first',
          cli_session_id: 'ses_first',
          error_message: 'Container shutdown: SIGTERM',
          terminal_reason: 'sandbox_error',
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    const caller = await createCallerForUser(testUser.id);

    await expect(caller.codeReviews.retrigger({ reviewId: review.id })).rejects.toThrow(
      'Code Reviewer is disabled because configuration needs attention'
    );

    const attempts = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id));
    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(attempts).toHaveLength(0);
    expect(storedReview?.status).toBe('failed');
    expect(mockTryDispatchPendingReviews).not.toHaveBeenCalled();
  });

  it('rejects stream info attempts from another review', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(reviewValues(testUser.id, 'running', { session_id: 'agent-review' }))
      .returning({ id: cloud_agent_code_reviews.id });
    const [otherReview] = await db
      .insert(cloud_agent_code_reviews)
      .values(reviewValues(testUser.id, 'running', { session_id: 'agent-other' }))
      .returning({ id: cloud_agent_code_reviews.id });
    const [otherAttempt] = await db
      .insert(cloud_agent_code_review_attempts)
      .values({
        code_review_id: otherReview.id,
        attempt_number: 1,
        status: 'running',
        session_id: 'agent-other',
      })
      .returning({ id: cloud_agent_code_review_attempts.id });

    const caller = await createCallerForUser(testUser.id);
    await expect(
      caller.codeReviews.getReviewStreamInfo({
        reviewId: review.id,
        attemptId: otherAttempt.id,
      })
    ).rejects.toThrow('Code review attempt not found');
  });
});
