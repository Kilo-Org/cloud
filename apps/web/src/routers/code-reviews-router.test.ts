const mockCancelReview = jest.fn();
const mockTryDispatchPendingReviews = jest.fn();
const mockSyncWebhooksForRepositories = jest.fn();
const mockGetValidGitLabToken = jest.fn();
const mockGetBlobContent = jest.fn();

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    cancelReview: (...args: unknown[]) => mockCancelReview(...args),
  },
}));

jest.mock('@/lib/code-reviews/dispatch/dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: (...args: unknown[]) => mockTryDispatchPendingReviews(...args),
}));

jest.mock('@/lib/integrations/platforms/gitlab/webhook-sync', () => ({
  syncWebhooksForRepositories: (...args: unknown[]) => mockSyncWebhooksForRepositories(...args),
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getValidGitLabToken: (...args: unknown[]) => mockGetValidGitLabToken(...args),
}));

jest.mock('@/lib/r2/cli-sessions', () => ({
  getBlobContent: (...args: unknown[]) => mockGetBlobContent(...args),
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
  cliSessions,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
  organization_audit_logs,
  organizations,
  platform_integrations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

const REPO = `test-org/code-reviews-cancel-${Date.now()}`;
type ReviewStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed';
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
    await db.delete(cliSessions).where(eq(cliSessions.kilo_user_id, testUser.id));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, testUser.id));
    mockCancelReview.mockReset();
    mockTryDispatchPendingReviews.mockReset();
    mockGetBlobContent.mockReset();
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

describe('personalReviewAgent.createManualReviewJob', () => {
  let testUser: User;
  let fetchSpy: jest.SpiedFunction<typeof fetch> | null = null;
  let previousDebugShowDevUi: string | undefined;
  let previousVercelEnv: string | undefined;
  const repo = `${REPO}-manual-job`;
  const prUrl = `https://github.com/${repo}/pull/1`;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  beforeEach(() => {
    previousDebugShowDevUi = process.env.DEBUG_SHOW_DEV_UI;
    previousVercelEnv = process.env.VERCEL_ENV;
    process.env.DEBUG_SHOW_DEV_UI = 'true';
    delete process.env.VERCEL_ENV;

    mockTryDispatchPendingReviews.mockResolvedValue(undefined);
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          number: 1,
          html_url: prUrl,
          title: 'Manual PR',
          state: 'open',
          draft: false,
          user: { login: 'octocat', id: 583231 },
          base: { ref: 'main', repo: { full_name: repo } },
          head: { ref: 'feature/manual', sha: 'manual-sha' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, repo));
    fetchSpy?.mockRestore();
    fetchSpy = null;
    mockTryDispatchPendingReviews.mockReset();

    if (previousDebugShowDevUi === undefined) {
      delete process.env.DEBUG_SHOW_DEV_UI;
    } else {
      process.env.DEBUG_SHOW_DEV_UI = previousDebugShowDevUi;
    }
    if (previousVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = previousVercelEnv;
    }
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  it('creates a fresh local manual review after the previous same-SHA job is cancelled', async () => {
    const caller = await createCallerForUser(testUser.id);

    const first = await caller.personalReviewAgent.createManualReviewJob({
      platform: 'github',
      url: prUrl,
      modelSlug: 'test-model',
    });
    await caller.codeReviews.cancel({ reviewId: first.reviewId });
    mockTryDispatchPendingReviews.mockClear();

    const second = await caller.personalReviewAgent.createManualReviewJob({
      platform: 'github',
      url: prUrl,
      modelSlug: 'test-model',
    });

    const rows = await db
      .select({
        id: cloud_agent_code_reviews.id,
        status: cloud_agent_code_reviews.status,
        manualConfig: cloud_agent_code_reviews.manual_config,
      })
      .from(cloud_agent_code_reviews)
      .where(inArray(cloud_agent_code_reviews.id, [first.reviewId, second.reviewId]));
    const firstRow = rows.find(row => row.id === first.reviewId);
    const secondRow = rows.find(row => row.id === second.reviewId);

    expect(second.reviewId).not.toBe(first.reviewId);
    expect(first).toEqual({ reviewId: first.reviewId, outputMode: 'kilo' });
    expect(second).toEqual({ reviewId: second.reviewId, outputMode: 'kilo' });
    expect(firstRow?.status).toBe('cancelled');
    expect(secondRow?.status).toBe('pending');
    expect(secondRow?.manualConfig?.outputMode).toBe('kilo');
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledWith({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });
  });
});

describe('review agent config REVIEW.md setting', () => {
  let testUser: User;
  let organization: Organization;

  beforeAll(async () => {
    testUser = await insertTestUser();
    organization = await createTestOrganization('Review Config Org', testUser.id, 0, {}, false);
  });

  beforeEach(() => {
    mockGetValidGitLabToken.mockResolvedValue('gitlab-token');
    mockSyncWebhooksForRepositories.mockResolvedValue({
      result: { created: [], updated: [], deleted: [], errors: [] },
      updatedWebhooks: {},
    });
  });

  afterEach(async () => {
    await db
      .delete(agent_configs)
      .where(
        and(
          eq(agent_configs.agent_type, 'code_review'),
          eq(agent_configs.owned_by_user_id, testUser.id)
        )
      );
    await db
      .delete(agent_configs)
      .where(
        and(
          eq(agent_configs.agent_type, 'code_review'),
          eq(agent_configs.owned_by_organization_id, organization.id)
        )
      );
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, testUser.id));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
    await db
      .delete(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id));
    mockGetValidGitLabToken.mockReset();
    mockSyncWebhooksForRepositories.mockReset();
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

  it('preserves personal review feature settings during a full config save', async () => {
    const caller = await createCallerForUser(testUser.id);
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'github',
      config: {
        review_memory_enabled: true,
        review_analytics_enabled: true,
      },
      is_enabled: false,
      created_by: testUser.id,
    });

    await caller.personalReviewAgent.saveReviewConfig({
      platform: 'github',
      reviewStyle: 'strict',
      focusAreas: ['correctness'],
      modelSlug: 'test-model',
    });

    const config = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });

    expect(config?.config).toEqual(
      expect.objectContaining({
        review_style: 'strict',
        review_memory_enabled: true,
        review_analytics_enabled: true,
      })
    );
  });

  it('keeps previous GitLab repository ids for webhook synchronization', async () => {
    const caller = await createCallerForUser(testUser.id);
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'gitlab',
      config: {
        selected_repository_ids: [101, 202],
        review_memory_enabled: true,
        review_analytics_enabled: true,
      },
      is_enabled: false,
      created_by: testUser.id,
    });
    await db.insert(platform_integrations).values({
      owned_by_user_id: testUser.id,
      platform: 'gitlab',
      integration_type: 'oauth',
      integration_status: 'active',
      metadata: {
        webhook_secret: 'webhook-secret',
        gitlab_instance_url: 'https://gitlab.example.com',
        configured_webhooks: {},
      },
    });

    await caller.personalReviewAgent.saveReviewConfig({
      platform: 'gitlab',
      reviewStyle: 'balanced',
      focusAreas: [],
      modelSlug: 'test-model',
      repositorySelectionMode: 'selected',
      selectedRepositoryIds: [202, 303],
    });

    expect(mockSyncWebhooksForRepositories).toHaveBeenCalledWith(
      'gitlab-token',
      'webhook-secret',
      [202, 303],
      [101, 202],
      {},
      'https://gitlab.example.com'
    );
  });

  it('preserves organization review feature settings during a full config save', async () => {
    const caller = await createCallerForUser(testUser.id);
    await db.insert(agent_configs).values({
      owned_by_organization_id: organization.id,
      agent_type: 'code_review',
      platform: 'github',
      config: {
        review_memory_enabled: true,
        review_analytics_enabled: true,
      },
      is_enabled: false,
      created_by: testUser.id,
    });

    await caller.organizations.reviewAgent.saveReviewConfig({
      organizationId: organization.id,
      platform: 'github',
      reviewStyle: 'lenient',
      focusAreas: ['maintainability'],
      modelSlug: 'test-model',
    });

    const config = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_organization_id, organization.id)
      ),
    });

    expect(config?.config).toEqual(
      expect.objectContaining({
        review_style: 'lenient',
        review_memory_enabled: true,
        review_analytics_enabled: true,
      })
    );
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

    expect(config?.config).toEqual(
      expect.objectContaining({
        disable_review_md: true,
        review_memory_enabled: false,
        review_analytics_enabled: false,
      })
    );
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

    expect(config?.config).toEqual(
      expect.objectContaining({
        disable_review_md: true,
        review_memory_enabled: false,
        review_analytics_enabled: false,
      })
    );
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
  const usageIds: string[] = [];

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  afterEach(async () => {
    if (usageIds.length > 0) {
      await db
        .delete(microdollar_usage_metadata)
        .where(inArray(microdollar_usage_metadata.id, usageIds));
      await db.delete(microdollar_usage).where(inArray(microdollar_usage.id, usageIds));
      usageIds.length = 0;
    }
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
    await db.delete(cliSessions).where(eq(cliSessions.kilo_user_id, testUser.id));
    await db.delete(agent_configs).where(eq(agent_configs.owned_by_user_id, testUser.id));
    mockCancelReview.mockReset();
    mockTryDispatchPendingReviews.mockReset();
    mockGetBlobContent.mockReset();
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
          total_tokens_in: 1200,
          total_tokens_out: 300,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    const caller = await createCallerForUser(testUser.id);
    const before = await caller.codeReviews.get({ reviewId: review.id });
    expect(before).toEqual(
      expect.objectContaining({
        success: true,
        attempts: [],
        tokenUsage: { input: 1200, output: 300, cached: 0 },
      })
    );

    await caller.codeReviews.retrigger({ reviewId: review.id });

    const after = await caller.codeReviews.get({ reviewId: review.id });
    expect(after).toEqual(
      expect.objectContaining({
        success: true,
        attempts: [
          expect.objectContaining({ session_id: 'agent-first', retry_reason: null }),
          expect.objectContaining({ retry_reason: 'manual_retrigger' }),
        ],
      })
    );

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });
    expect(storedReview?.status).toBe('pending');
    expect(storedReview?.session_id).toBeNull();
  });

  it('returns billing-derived display token usage from get', async () => {
    const sessionId = `ses_router_usage_${crypto.randomUUID()}`;
    const usageId = crypto.randomUUID();
    usageIds.push(usageId);

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues(testUser.id, 'completed', {
          cli_session_id: sessionId,
          created_at: '2026-06-18T09:00:00.000Z',
          started_at: '2026-06-18T09:10:00.000Z',
          completed_at: '2026-06-18T11:00:00.000Z',
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    await db.insert(microdollar_usage).values({
      id: usageId,
      kilo_user_id: testUser.id,
      cost: 100,
      input_tokens: 1000,
      output_tokens: 200,
      cache_write_tokens: 100,
      cache_hit_tokens: 600,
      created_at: '2026-06-18T10:00:00.000Z',
      model: 'anthropic/claude-sonnet-4.6',
    });
    await db.insert(microdollar_usage_metadata).values({
      id: usageId,
      message_id: `msg_${usageId}`,
      session_id: sessionId,
      created_at: '2026-06-18T10:00:00.000Z',
    });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.codeReviews.get({ reviewId: review.id });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        tokenUsage: { input: 300, output: 200, cached: 700 },
      })
    );
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

  it('loads a historical V1 review from PostgreSQL and R2 without a worker request', async () => {
    const cliSessionId = crypto.randomUUID();
    await db.insert(cliSessions).values({
      session_id: cliSessionId,
      kilo_user_id: testUser.id,
      title: 'Historical V1 code review',
      created_on_platform: 'vscode',
      ui_messages_blob_url: `sessions/${cliSessionId}/ui_messages.json`,
    });
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues(testUser.id, 'completed', {
          agent_version: 'v1',
          cli_session_id: cliSessionId,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });
    mockGetBlobContent.mockResolvedValue([
      {
        type: 'say',
        say: 'completion_result',
        text: 'Historical review result',
        ts: Date.now(),
      },
    ]);
    const fetchSpy = jest.spyOn(global, 'fetch');

    try {
      const caller = await createCallerForUser(testUser.id);
      const result = await caller.codeReviews.getSessionMessages({ reviewId: review.id });

      expect(result).toMatchObject({
        success: true,
        entries: [{ eventType: 'text', message: 'Historical review result' }],
      });
      expect(mockGetBlobContent).toHaveBeenCalledWith(`sessions/${cliSessionId}/ui_messages.json`);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
