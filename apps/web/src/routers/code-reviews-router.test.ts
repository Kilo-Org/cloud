const mockCancelReview = jest.fn();
const mockTryDispatchPendingReviews = jest.fn();
const mockSyncWebhooksForRepositories = jest.fn();
const mockGetValidGitLabToken = jest.fn();
const mockGetBlobContent = jest.fn();
const mockEnsureBitbucketCodeReviewWorkspaceWebhook = jest.fn();
const mockDeleteBitbucketCodeReviewWorkspaceWebhooksBestEffort = jest.fn();
const mockEnsureBotUserForOrg = jest.fn();
const mockFetchBitbucketPullRequest = jest.fn();

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

jest.mock('@/lib/integrations/platforms/bitbucket/code-review-webhooks', () => {
  class BitbucketCodeReviewWebhookConfigurationError extends Error {
    constructor(readonly code: 'signing_configuration_invalid' | 'callback_origin_invalid') {
      super(code);
      this.name = 'BitbucketCodeReviewWebhookConfigurationError';
    }
  }

  return {
    BitbucketCodeReviewWebhookConfigurationError,
    ensureBitbucketCodeReviewWorkspaceWebhook: (...args: unknown[]) =>
      mockEnsureBitbucketCodeReviewWorkspaceWebhook(...args),
    deleteBitbucketCodeReviewWorkspaceWebhooksBestEffort: (...args: unknown[]) =>
      mockDeleteBitbucketCodeReviewWorkspaceWebhooksBestEffort(...args),
  };
});

jest.mock('@/lib/integrations/platforms/bitbucket/token-service-client', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/lib/integrations/platforms/bitbucket/token-service-client'
  );
  return {
    ...actual,
    fetchBitbucketPullRequestFromTokenService: (...args: unknown[]) =>
      mockFetchBitbucketPullRequest(...args),
  };
});

jest.mock('@/lib/bot-users/bot-user-service', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/lib/bot-users/bot-user-service');
  return {
    ...actual,
    ensureBotUserForOrg: (...args: unknown[]) => mockEnsureBotUserForOrg(...args),
  };
});

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
import type { SuccessResult } from '@/lib/maybe-result';
import type * as BotUserService from '@/lib/bot-users/bot-user-service';
import { generateBotUserId } from '@/lib/bot-users/types';
import { BitbucketCodeReviewWebhookConfigurationError } from '@/lib/integrations/platforms/bitbucket/code-review-webhooks';
import { updateCheckRun } from '@/lib/integrations/platforms/github/adapter';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { addUserToOrganization } from '@/lib/organizations/organizations';
import {
  agent_configs,
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  cliSessions,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
  organization_audit_logs,
  organization_memberships,
  organizations,
  platform_access_token_credentials,
  platform_integrations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { and, eq, inArray, or } from 'drizzle-orm';

const REPO = `test-org/code-reviews-cancel-${Date.now()}`;
const BITBUCKET_WORKSPACE_UUID = '11111111-1111-4111-8111-111111111111';
const BITBUCKET_REPOSITORY_UUID = '22222222-2222-4222-8222-222222222222';
const BITBUCKET_REQUIRED_SCOPES = [
  'account',
  'repository',
  'repository:write',
  'pullrequest',
  'webhook',
];
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

function providerBitbucketPullRequest(
  overrides: {
    id?: number;
    state?: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
    draft?: boolean;
    headSha?: string;
  } = {}
) {
  const pullRequestId = overrides.id ?? 42;
  const headSha = overrides.headSha ?? 'a'.repeat(40);
  return {
    success: true as const,
    pullRequest: {
      id: pullRequestId,
      state: overrides.state ?? 'OPEN',
      draft: overrides.draft ?? false,
      updatedOn: '2026-06-24T13:30:45.123Z',
      title: 'Manual review target',
      author: {
        uuid: '44444444-4444-4444-8444-444444444444',
        displayName: 'Ada Reviewer',
      },
      source: {
        repositoryUuid: BITBUCKET_REPOSITORY_UUID,
        repositoryFullName: 'acme/api',
        branch: 'feature/manual-review',
        sha: headSha,
      },
      destination: {
        repositoryUuid: BITBUCKET_REPOSITORY_UUID,
        repositoryFullName: 'acme/api',
        branch: 'main',
        sha: 'b'.repeat(40),
      },
      url: `https://bitbucket.org/acme/api/pull-requests/${pullRequestId}`,
    },
  };
}

beforeEach(() => {
  mockEnsureBitbucketCodeReviewWorkspaceWebhook.mockResolvedValue({
    success: true,
    webhook: {
      uuid: '55555555-5555-4555-8555-555555555555',
      callbackUrl: 'https://app.kilo.ai/api/webhooks/bitbucket/test',
      active: true,
      events: ['pullrequest:created'],
      secretSet: true,
    },
  });
  mockDeleteBitbucketCodeReviewWorkspaceWebhooksBestEffort.mockResolvedValue(undefined);
  mockEnsureBotUserForOrg.mockResolvedValue({ id: 'code-review-bot' });
});

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

describe('codeReviewRouter.listForOrganization role-gated ids', () => {
  let ownerUser: User;
  let memberUser: User;
  let organization: Organization;

  beforeAll(async () => {
    ownerUser = await insertTestUser({
      google_user_email: 'list-ids-owner@example.com',
      google_user_name: 'List Ids Owner',
      is_admin: false,
    });
    memberUser = await insertTestUser({
      google_user_email: 'list-ids-member@example.com',
      google_user_name: 'List Ids Member',
      is_admin: false,
    });
    organization = await createTestOrganization('List Ids Org', ownerUser.id, 0, {}, false);
    await addUserToOrganization(organization.id, memberUser.id, 'member');
  });

  afterAll(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.owned_by_organization_id, organization.id));
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, organization.id));
    await db.delete(organizations).where(eq(organizations.id, organization.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, memberUser.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, ownerUser.id));
  });

  it('nulls raw ledger/transaction ids for members and keeps them for owners', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_organization_id: organization.id,
        owned_by_user_id: null,
        platform_integration_id: null,
        repo_full_name: 'test-org/list-ids-repo',
        pr_number: 1,
        pr_url: 'https://github.com/test-org/list-ids-repo/pull/1',
        pr_title: 'List ids PR',
        pr_author: 'octocat',
        base_ref: 'main',
        head_ref: 'feature/list-ids',
        head_sha: 'sha-list-ids',
        status: 'completed',
        session_id: 'agent-session-list-ids',
        cli_session_id: 'ses-list-ids',
        dispatch_reservation_id: 'reservation-list-ids',
        check_run_id: 12345,
        total_cost_musd: 500,
      })
      .returning({ id: cloud_agent_code_reviews.id });

    try {
      const memberCaller = await createCallerForUser(memberUser.id);
      const memberResult = await memberCaller.codeReviews.listForOrganization({
        organizationId: organization.id,
      });
      expect(memberResult.success).toBe(true);
      if (!memberResult.success) throw new Error('expected member list success');
      const memberReview = memberResult.reviews.find(r => r.id === review.id);
      expect(memberReview).toBeDefined();
      expect(memberReview?.session_id).toBeNull();
      expect(memberReview?.cli_session_id).toBeNull();
      expect(memberReview?.dispatch_reservation_id).toBeNull();
      expect(memberReview?.check_run_id).toBeNull();
      expect(memberReview?.total_cost_musd).toBe(500);

      const ownerCaller = await createCallerForUser(ownerUser.id);
      const ownerResult = await ownerCaller.codeReviews.listForOrganization({
        organizationId: organization.id,
      });
      expect(ownerResult.success).toBe(true);
      if (!ownerResult.success) throw new Error('expected owner list success');
      const ownerReview = ownerResult.reviews.find(r => r.id === review.id);
      expect(ownerReview).toBeDefined();
      expect(ownerReview?.session_id).toBe('agent-session-list-ids');
      expect(ownerReview?.cli_session_id).toBe('ses-list-ids');
      expect(ownerReview?.dispatch_reservation_id).toBe('reservation-list-ids');
      expect(ownerReview?.check_run_id).toBe(12345);
      expect(ownerReview?.total_cost_musd).toBe(500);
    } finally {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, review.id));
    }
  });
});

describe('codeReviewRouter.get role-gated ids', () => {
  let ownerUser: User;
  let memberUser: User;
  let organization: Organization;

  beforeAll(async () => {
    ownerUser = await insertTestUser({
      google_user_email: 'get-ids-owner@example.com',
      google_user_name: 'Get Ids Owner',
      is_admin: false,
    });
    memberUser = await insertTestUser({
      google_user_email: 'get-ids-member@example.com',
      google_user_name: 'Get Ids Member',
      is_admin: false,
    });
    organization = await createTestOrganization('Get Ids Org', ownerUser.id, 0, {}, false);
    await addUserToOrganization(organization.id, memberUser.id, 'member');
  });

  afterAll(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.owned_by_organization_id, organization.id));
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, organization.id));
    await db.delete(organizations).where(eq(organizations.id, organization.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, memberUser.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, ownerUser.id));
  });

  it('nulls raw identifiers for members and keeps them for owners', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_organization_id: organization.id,
        owned_by_user_id: null,
        platform_integration_id: null,
        repo_full_name: 'test-org/get-ids-repo',
        pr_number: 1,
        pr_url: 'https://github.com/test-org/get-ids-repo/pull/1',
        pr_title: 'Get ids PR',
        pr_author: 'octocat',
        base_ref: 'main',
        head_ref: 'feature/get-ids',
        head_sha: 'sha-get-ids',
        status: 'completed',
        session_id: 'agent-session-get-ids',
        cli_session_id: 'ses-get-ids',
        dispatch_reservation_id: 'reservation-get-ids',
        check_run_id: 12345,
        total_cost_musd: 500,
      })
      .returning({ id: cloud_agent_code_reviews.id });

    await db.insert(cloud_agent_code_review_attempts).values({
      code_review_id: review.id,
      attempt_number: 1,
      status: 'completed',
      session_id: 'agent-attempt-get-ids',
      cli_session_id: 'ses-attempt-get-ids',
      execution_id: 'exec-attempt-get-ids',
    });

    try {
      const memberCaller = await createCallerForUser(memberUser.id);
      const memberResult = await memberCaller.codeReviews.get({ reviewId: review.id });
      expect(memberResult.success).toBe(true);
      if (!memberResult.success) throw new Error('expected member get success');
      expect(memberResult.review.session_id).toBeNull();
      expect(memberResult.review.cli_session_id).toBeNull();
      expect(memberResult.review.dispatch_reservation_id).toBeNull();
      expect(memberResult.review.check_run_id).toBeNull();
      expect(memberResult.review.total_cost_musd).toBe(500);
      expect(memberResult.attempts).toHaveLength(1);
      expect(memberResult.attempts[0]?.session_id).toBeNull();
      expect(memberResult.attempts[0]?.cli_session_id).toBeNull();
      expect(memberResult.attempts[0]?.execution_id).toBeNull();

      const ownerCaller = await createCallerForUser(ownerUser.id);
      const ownerResult = await ownerCaller.codeReviews.get({ reviewId: review.id });
      expect(ownerResult.success).toBe(true);
      if (!ownerResult.success) throw new Error('expected owner get success');
      expect(ownerResult.review.session_id).toBe('agent-session-get-ids');
      expect(ownerResult.review.cli_session_id).toBe('ses-get-ids');
      expect(ownerResult.review.dispatch_reservation_id).toBe('reservation-get-ids');
      expect(ownerResult.review.check_run_id).toBe(12345);
      expect(ownerResult.review.total_cost_musd).toBe(500);
      expect(ownerResult.attempts).toHaveLength(1);
      expect(ownerResult.attempts[0]?.session_id).toBe('agent-attempt-get-ids');
      expect(ownerResult.attempts[0]?.cli_session_id).toBe('ses-attempt-get-ids');
      expect(ownerResult.attempts[0]?.execution_id).toBe('exec-attempt-get-ids');
    } finally {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, review.id));
    }
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
  let adminUser: User;
  let organization: Organization;

  beforeAll(async () => {
    testUser = await insertTestUser();
    adminUser = await insertTestUser({
      google_user_email: 'code-review-admin@example.com',
      is_admin: true,
    });
    organization = await createTestOrganization('Review Config Org', testUser.id, 0, {}, false);
  });

  beforeEach(() => {
    mockFetchBitbucketPullRequest.mockResolvedValue(providerBitbucketPullRequest());
    mockGetValidGitLabToken.mockResolvedValue('gitlab-token');
    mockSyncWebhooksForRepositories.mockResolvedValue({
      result: { created: [], updated: [], deleted: [], errors: [] },
      updatedWebhooks: {},
    });
  });

  async function insertBitbucketIntegration(providerScopes = BITBUCKET_REQUIRED_SCOPES) {
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        owned_by_user_id: null,
        created_by_user_id: testUser.id,
        platform: 'bitbucket',
        integration_type: 'workspace_access_token',
        platform_account_id: BITBUCKET_WORKSPACE_UUID,
        platform_account_login: 'acme',
        platform_installation_id: null,
        repository_access: 'all',
        repositories: [
          {
            id: BITBUCKET_REPOSITORY_UUID,
            name: 'API',
            full_name: 'acme/api',
            private: true,
            default_branch: 'main',
          },
        ],
        repositories_synced_at: '2026-06-24T08:00:00.000Z',
        integration_status: 'active',
        metadata: { displayName: 'Acme Workspace' },
      })
      .returning();
    if (!integration) throw new Error('Expected Bitbucket integration');

    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: integration.id,
      token_encrypted: 'encrypted-token',
      provider_credential_type: 'workspace_access_token',
      provider_scopes: providerScopes,
      provider_verified_at: '2026-06-24T08:00:00.000Z',
      credential_version: 1,
      last_validated_at: '2026-06-24T08:00:00.000Z',
    });

    return integration;
  }

  async function insertBitbucketConfig(input: {
    enabled: boolean;
    repositoryIds?: Array<number | string>;
    overrides?: Record<string, unknown>;
  }) {
    await db.insert(agent_configs).values({
      owned_by_organization_id: organization.id,
      agent_type: 'code_review',
      platform: 'bitbucket',
      config: {
        review_style: 'balanced',
        focus_areas: [],
        model_slug: 'test-model',
        repository_selection_mode: 'selected',
        selected_repository_ids: input.repositoryIds ?? [BITBUCKET_REPOSITORY_UUID],
        gate_threshold: 'off',
        disable_review_md: true,
        review_memory_enabled: false,
        review_analytics_enabled: false,
        ...input.overrides,
      },
      is_enabled: input.enabled,
      created_by: testUser.id,
    });
  }

  async function insertCodeReviewerBot() {
    const codeReviewerBot = await insertTestUser({
      id: generateBotUserId(organization.id, 'code-review'),
      is_bot: true,
    });
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: codeReviewerBot.id,
      role: 'member',
    });
    return codeReviewerBot;
  }

  async function expectEnablementRaceRejected(
    mutateAfterEnsure: (integrationId: string) => Promise<void>,
    expectedCode: string
  ) {
    const integration = await insertBitbucketIntegration();
    await insertBitbucketConfig({ enabled: false });
    mockEnsureBitbucketCodeReviewWorkspaceWebhook.mockImplementationOnce(async () => {
      await mutateAfterEnsure(integration.id);
      return {
        success: true,
        webhook: {
          uuid: '55555555-5555-4555-8555-555555555555',
          callbackUrl: 'https://app.kilo.ai/api/webhooks/bitbucket/test',
          active: true,
          events: ['pullrequest:created'],
          secretSet: true,
        },
      };
    });
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.organizations.reviewAgent.toggleReviewAgent({
        organizationId: organization.id,
        platform: 'bitbucket',
        isEnabled: true,
      })
    ).rejects.toMatchObject({ code: expectedCode });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.owned_by_organization_id, organization.id),
        eq(agent_configs.platform, 'bitbucket')
      ),
    });
    expect(stored?.is_enabled).toBe(false);
    expect(mockEnsureBitbucketCodeReviewWorkspaceWebhook).toHaveBeenCalledTimes(1);
  }

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.owned_by_organization_id, organization.id));
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
    mockEnsureBitbucketCodeReviewWorkspaceWebhook.mockReset();
    mockDeleteBitbucketCodeReviewWorkspaceWebhooksBestEffort.mockReset();
    mockEnsureBotUserForOrg.mockReset();
    mockFetchBitbucketPullRequest.mockReset();
    await db
      .delete(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, organization.id),
          eq(
            organization_memberships.kilo_user_id,
            generateBotUserId(organization.id, 'code-review')
          )
        )
      );
    await db
      .delete(kilocode_users)
      .where(eq(kilocode_users.id, generateBotUserId(organization.id, 'code-review')));
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, organization.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, adminUser.id));
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

  it('returns UI-safe Bitbucket Code Reviewer readiness from stored scopes and cache', async () => {
    const integration = await insertBitbucketIntegration();
    const caller = await createCallerForUser(testUser.id);

    const readiness = await caller.organizations.reviewAgent.getBitbucketReadiness({
      organizationId: organization.id,
    });

    expect(readiness).toEqual({
      connected: true,
      ready: true,
      integrationId: integration.id,
      workspace: {
        uuid: BITBUCKET_WORKSPACE_UUID,
        slug: 'acme',
        displayName: 'Acme Workspace',
      },
      missingRequiredScopes: [],
      repositoryCache: {
        status: 'available',
        repositories: [
          expect.objectContaining({
            id: BITBUCKET_REPOSITORY_UUID,
            fullName: 'acme/api',
          }),
        ],
        syncedAt: '2026-06-24T08:00:00.000Z',
      },
      canManage: true,
      canTriggerManualReview: false,
    });
    expect(JSON.stringify(readiness)).not.toContain('encrypted-token');
    expect(readiness).not.toHaveProperty('providerScopes');
  });

  it('lets platform admins start a Bitbucket Code Reviewer job from a pull request URL', async () => {
    const integration = await insertBitbucketIntegration();
    await insertBitbucketConfig({ enabled: true });
    const codeReviewerBot = await insertCodeReviewerBot();
    mockTryDispatchPendingReviews.mockResolvedValue({
      dispatched: 1,
      notDispatched: 0,
      activeCount: 1,
    });
    const caller = await createCallerForUser(adminUser.id);

    const result = await caller.organizations.reviewAgent.triggerBitbucketCodeReview({
      organizationId: organization.id,
      pullRequestUrl: 'https://bitbucket.org/acme/api/pull-requests/42',
    });

    expect(result).toEqual({
      status: 'queued',
      reviewId: expect.any(String),
    });
    const reviews = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.owned_by_organization_id, organization.id));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual(
      expect.objectContaining({
        id: result.reviewId,
        platform: 'bitbucket',
        platform_integration_id: integration.id,
        repo_full_name: 'acme/api',
        pr_number: 42,
        pr_url: 'https://bitbucket.org/acme/api/pull-requests/42',
        pr_title: 'Manual review target',
        pr_author: 'Ada Reviewer',
        base_ref: 'main',
        head_ref: 'feature/manual-review',
        head_sha: 'a'.repeat(40),
        status: 'pending',
      })
    );
    expect(mockFetchBitbucketPullRequest).toHaveBeenCalledWith({
      botUserId: codeReviewerBot.id,
      organizationId: organization.id,
      workspace: {
        integrationId: integration.id,
        workspaceUuid: BITBUCKET_WORKSPACE_UUID,
        workspaceSlug: 'acme',
      },
      repository: {
        repositoryUuid: BITBUCKET_REPOSITORY_UUID,
        repositoryFullName: 'acme/api',
      },
      pullRequestId: 42,
    });
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledWith({
      type: 'org',
      id: organization.id,
      userId: codeReviewerBot.id,
    });
  });

  it('rejects manual Bitbucket Code Reviewer triggers from non-admin organization owners', async () => {
    await insertBitbucketIntegration();
    await insertBitbucketConfig({ enabled: true });
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.organizations.reviewAgent.triggerBitbucketCodeReview({
        organizationId: organization.id,
        pullRequestUrl: 'https://bitbucket.org/acme/api/pull-requests/42',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockFetchBitbucketPullRequest).not.toHaveBeenCalled();
  });

  it('saves a new Bitbucket config disabled without hook work and round-trips UUIDs', async () => {
    await insertBitbucketIntegration();
    const caller = await createCallerForUser(testUser.id);

    await caller.organizations.reviewAgent.saveReviewConfig({
      organizationId: organization.id,
      platform: 'bitbucket',
      reviewStyle: 'strict',
      focusAreas: ['correctness'],
      modelSlug: 'test-model',
      repositorySelectionMode: 'selected',
      selectedRepositoryIds: [BITBUCKET_REPOSITORY_UUID],
      manuallyAddedRepositories: [
        { id: 99, name: 'Manual', full_name: 'manual/repo', private: true },
      ],
      gateThreshold: 'critical',
      disableReviewMd: false,
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.owned_by_organization_id, organization.id),
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'bitbucket')
      ),
    });
    const returned = await caller.organizations.reviewAgent.getReviewConfig({
      organizationId: organization.id,
      platform: 'bitbucket',
    });

    expect(mockEnsureBitbucketCodeReviewWorkspaceWebhook).not.toHaveBeenCalled();
    expect(stored?.is_enabled).toBe(false);
    expect(stored?.config).toEqual(
      expect.objectContaining({
        selected_repository_ids: [BITBUCKET_REPOSITORY_UUID],
        repository_selection_mode: 'selected',
        manually_added_repositories: [],
        gate_threshold: 'off',
        disable_review_md: true,
        review_memory_enabled: false,
        review_analytics_enabled: false,
      })
    );
    expect(returned.selectedRepositoryIds).toEqual([BITBUCKET_REPOSITORY_UUID]);
    expect(returned).toEqual(
      expect.objectContaining({
        gateThreshold: 'off',
        disableReviewMd: true,
        reviewMemoryEnabled: false,
        manuallyAddedRepositories: [],
      })
    );
  });

  it.each(['github', 'gitlab'] as const)(
    'keeps %s config reads numeric when stored data contains a string ID',
    async platform => {
      await db.insert(agent_configs).values({
        owned_by_organization_id: organization.id,
        agent_type: 'code_review',
        platform,
        config: {
          review_style: 'balanced',
          focus_areas: [],
          model_slug: 'test-model',
          selected_repository_ids: [101, BITBUCKET_REPOSITORY_UUID],
        },
        is_enabled: false,
        created_by: testUser.id,
      });
      const caller = await createCallerForUser(testUser.id);

      const config = await caller.organizations.reviewAgent.getReviewConfig({
        organizationId: organization.id,
        platform,
      });

      expect(config.selectedRepositoryIds).toEqual([101]);
    }
  );

  it.each(['github', 'gitlab'] as const)(
    'accepts only numeric repository IDs when saving %s organization config',
    async platform => {
      const caller = await createCallerForUser(testUser.id);
      const input = {
        organizationId: organization.id,
        platform,
        reviewStyle: 'balanced' as const,
        focusAreas: [],
        modelSlug: 'test-model',
        repositorySelectionMode: 'selected' as const,
        autoConfigureWebhooks: false,
      };

      await caller.organizations.reviewAgent.saveReviewConfig({
        ...input,
        selectedRepositoryIds: [101, 202],
      });
      await expect(
        caller.organizations.reviewAgent.saveReviewConfig({
          ...input,
          selectedRepositoryIds: [101, BITBUCKET_REPOSITORY_UUID],
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      const stored = await db.query.agent_configs.findFirst({
        where: and(
          eq(agent_configs.owned_by_organization_id, organization.id),
          eq(agent_configs.platform, platform)
        ),
      });
      expect(stored?.config).toEqual(
        expect.objectContaining({ selected_repository_ids: [101, 202] })
      );
    }
  );

  it('rejects non-selected, empty, and non-cached Bitbucket repository selections', async () => {
    await insertBitbucketIntegration();
    const caller = await createCallerForUser(testUser.id);
    const baseInput = {
      organizationId: organization.id,
      platform: 'bitbucket' as const,
      reviewStyle: 'balanced' as const,
      focusAreas: [],
      modelSlug: 'test-model',
    };

    await expect(
      caller.organizations.reviewAgent.saveReviewConfig({
        ...baseInput,
        repositorySelectionMode: 'all',
        selectedRepositoryIds: [BITBUCKET_REPOSITORY_UUID],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.organizations.reviewAgent.saveReviewConfig({
        ...baseInput,
        repositorySelectionMode: 'selected',
        selectedRepositoryIds: [],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.organizations.reviewAgent.saveReviewConfig({
        ...baseInput,
        repositorySelectionMode: 'selected',
        selectedRepositoryIds: [101],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.organizations.reviewAgent.saveReviewConfig({
        ...baseInput,
        repositorySelectionMode: 'selected',
        selectedRepositoryIds: ['33333333-3333-4333-8333-333333333333'],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('ensures the Bitbucket workspace hook before persisting an enabled config save', async () => {
    await insertBitbucketIntegration();
    await insertBitbucketConfig({ enabled: true });
    mockEnsureBitbucketCodeReviewWorkspaceWebhook.mockImplementationOnce(async () => {
      const current = await db.query.agent_configs.findFirst({
        where: and(
          eq(agent_configs.owned_by_organization_id, organization.id),
          eq(agent_configs.platform, 'bitbucket')
        ),
      });
      expect(current?.config).toEqual(expect.objectContaining({ review_style: 'balanced' }));
      return {
        success: true,
        webhook: {
          uuid: '55555555-5555-4555-8555-555555555555',
          callbackUrl: 'https://app.kilo.ai/api/webhooks/bitbucket/test',
          active: true,
          events: ['pullrequest:created'],
          secretSet: true,
        },
      };
    });
    const caller = await createCallerForUser(testUser.id);

    await caller.organizations.reviewAgent.saveReviewConfig({
      organizationId: organization.id,
      platform: 'bitbucket',
      reviewStyle: 'strict',
      focusAreas: [],
      modelSlug: 'test-model',
      repositorySelectionMode: 'selected',
      selectedRepositoryIds: [BITBUCKET_REPOSITORY_UUID],
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.owned_by_organization_id, organization.id),
        eq(agent_configs.platform, 'bitbucket')
      ),
    });
    expect(mockEnsureBitbucketCodeReviewWorkspaceWebhook).toHaveBeenCalledTimes(1);
    expect(stored?.config).toEqual(expect.objectContaining({ review_style: 'strict' }));
    expect(stored?.is_enabled).toBe(true);
  });

  it('preserves the old enabled Bitbucket config when hook ensure fails', async () => {
    await insertBitbucketIntegration();
    await insertBitbucketConfig({ enabled: true });
    mockEnsureBitbucketCodeReviewWorkspaceWebhook.mockResolvedValueOnce({
      success: false,
      reason: 'temporarily_unavailable',
    });
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.organizations.reviewAgent.saveReviewConfig({
        organizationId: organization.id,
        platform: 'bitbucket',
        reviewStyle: 'strict',
        focusAreas: [],
        modelSlug: 'test-model',
        repositorySelectionMode: 'selected',
        selectedRepositoryIds: [BITBUCKET_REPOSITORY_UUID],
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.owned_by_organization_id, organization.id),
        eq(agent_configs.platform, 'bitbucket')
      ),
    });
    expect(stored?.config).toEqual(expect.objectContaining({ review_style: 'balanced' }));
    expect(stored?.is_enabled).toBe(true);
  });

  it('rejects Bitbucket enable when connection scopes are incomplete', async () => {
    await insertBitbucketIntegration(['account', 'repository', 'repository:write']);
    await insertBitbucketConfig({ enabled: false });
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.organizations.reviewAgent.toggleReviewAgent({
        organizationId: organization.id,
        platform: 'bitbucket',
        isEnabled: true,
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.owned_by_organization_id, organization.id),
        eq(agent_configs.platform, 'bitbucket')
      ),
    });
    expect(stored?.is_enabled).toBe(false);
    expect(mockEnsureBotUserForOrg).not.toHaveBeenCalled();
    expect(mockEnsureBitbucketCodeReviewWorkspaceWebhook).not.toHaveBeenCalled();
  });

  it('rejects Bitbucket enable without a saved configuration', async () => {
    await insertBitbucketIntegration();
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.organizations.reviewAgent.toggleReviewAgent({
        organizationId: organization.id,
        platform: 'bitbucket',
        isEnabled: true,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockEnsureBotUserForOrg).not.toHaveBeenCalled();
    expect(mockEnsureBitbucketCodeReviewWorkspaceWebhook).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'blocked_at',
      blockedAt: '2026-06-24T12:00:00.000Z',
      blockedReason: null,
    },
    {
      name: 'blocked_reason',
      blockedAt: null,
      blockedReason: 'policy_violation',
    },
  ])('rejects Bitbucket enable when the existing Code Reviewer bot has $name', async testCase => {
    await insertBitbucketIntegration();
    await insertBitbucketConfig({ enabled: false });
    const botId = generateBotUserId(organization.id, 'code-review');
    await insertTestUser({
      id: botId,
      is_bot: true,
      blocked_at: testCase.blockedAt,
      blocked_reason: testCase.blockedReason,
    });
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: botId,
      role: 'member',
    });
    const actualBotUserService = jest.requireActual<typeof BotUserService>(
      '@/lib/bot-users/bot-user-service'
    );
    mockEnsureBotUserForOrg.mockImplementationOnce(actualBotUserService.ensureBotUserForOrg);
    const caller = await createCallerForUser(testUser.id);

    try {
      await expect(
        caller.organizations.reviewAgent.toggleReviewAgent({
          organizationId: organization.id,
          platform: 'bitbucket',
          isEnabled: true,
        })
      ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
      expect(mockEnsureBitbucketCodeReviewWorkspaceWebhook).not.toHaveBeenCalled();
    } finally {
      await db
        .delete(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, organization.id),
            eq(organization_memberships.kilo_user_id, botId)
          )
        );
      await db.delete(kilocode_users).where(eq(kilocode_users.id, botId));
    }
  });

  it('keeps Bitbucket locally disabled when enable hook setup fails', async () => {
    await insertBitbucketIntegration();
    await insertBitbucketConfig({ enabled: false });
    mockEnsureBitbucketCodeReviewWorkspaceWebhook.mockResolvedValueOnce({
      success: false,
      reason: 'temporarily_unavailable',
    });
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.organizations.reviewAgent.toggleReviewAgent({
        organizationId: organization.id,
        platform: 'bitbucket',
        isEnabled: true,
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.owned_by_organization_id, organization.id),
        eq(agent_configs.platform, 'bitbucket')
      ),
    });
    expect(stored?.is_enabled).toBe(false);
    expect(mockEnsureBotUserForOrg).toHaveBeenCalledWith(organization.id, 'code-review');
  });

  it('keeps Bitbucket locally disabled and explains invalid callback origin setup', async () => {
    await insertBitbucketIntegration();
    await insertBitbucketConfig({ enabled: false });
    mockEnsureBitbucketCodeReviewWorkspaceWebhook.mockRejectedValueOnce(
      new BitbucketCodeReviewWebhookConfigurationError('callback_origin_invalid')
    );
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.organizations.reviewAgent.toggleReviewAgent({
        organizationId: organization.id,
        platform: 'bitbucket',
        isEnabled: true,
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL'),
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.owned_by_organization_id, organization.id),
        eq(agent_configs.platform, 'bitbucket')
      ),
    });
    expect(stored?.is_enabled).toBe(false);
    expect(mockEnsureBotUserForOrg).toHaveBeenCalledWith(organization.id, 'code-review');
  });

  it('enables Bitbucket locally only after bot and workspace hook setup succeed', async () => {
    await insertBitbucketIntegration();
    await insertBitbucketConfig({ enabled: false });
    mockEnsureBitbucketCodeReviewWorkspaceWebhook.mockImplementationOnce(async () => {
      const current = await db.query.agent_configs.findFirst({
        where: and(
          eq(agent_configs.owned_by_organization_id, organization.id),
          eq(agent_configs.platform, 'bitbucket')
        ),
      });
      expect(current?.is_enabled).toBe(false);
      return {
        success: true,
        webhook: {
          uuid: '55555555-5555-4555-8555-555555555555',
          callbackUrl: 'https://app.kilo.ai/api/webhooks/bitbucket/test',
          active: true,
          events: ['pullrequest:created'],
          secretSet: true,
        },
      };
    });
    const caller = await createCallerForUser(testUser.id);

    await caller.organizations.reviewAgent.toggleReviewAgent({
      organizationId: organization.id,
      platform: 'bitbucket',
      isEnabled: true,
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.owned_by_organization_id, organization.id),
        eq(agent_configs.platform, 'bitbucket')
      ),
    });
    expect(stored?.is_enabled).toBe(true);
    expect(mockEnsureBotUserForOrg.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnsureBitbucketCodeReviewWorkspaceWebhook.mock.invocationCallOrder[0]
    );
  });

  it('rejects enable when the Bitbucket integration identity changes after hook ensure', async () => {
    await expectEnablementRaceRejected(async integrationId => {
      await db
        .update(platform_integrations)
        .set({ platform_account_id: '33333333-3333-4333-8333-333333333333' })
        .where(eq(platform_integrations.id, integrationId));
    }, 'CONFLICT');
  });

  it('rejects enable when connection scopes change after hook ensure', async () => {
    await expectEnablementRaceRejected(async integrationId => {
      await db
        .update(platform_access_token_credentials)
        .set({ provider_scopes: ['account', 'repository', 'repository:write'] })
        .where(eq(platform_access_token_credentials.platform_integration_id, integrationId));
    }, 'PRECONDITION_FAILED');
  });

  it('rejects enable when selected repositories become invalid after hook ensure', async () => {
    await expectEnablementRaceRejected(async () => {
      await db
        .update(agent_configs)
        .set({
          config: {
            review_style: 'balanced',
            focus_areas: [],
            model_slug: 'test-model',
            repository_selection_mode: 'selected',
            selected_repository_ids: ['44444444-4444-4444-8444-444444444444'],
          },
        })
        .where(
          and(
            eq(agent_configs.owned_by_organization_id, organization.id),
            eq(agent_configs.platform, 'bitbucket')
          )
        );
    }, 'BAD_REQUEST');
  });

  it('disables Bitbucket locally before best-effort hook deletion', async () => {
    await insertBitbucketIntegration();
    await insertBitbucketConfig({ enabled: true });
    mockDeleteBitbucketCodeReviewWorkspaceWebhooksBestEffort.mockImplementationOnce(async () => {
      const current = await db.query.agent_configs.findFirst({
        where: and(
          eq(agent_configs.owned_by_organization_id, organization.id),
          eq(agent_configs.platform, 'bitbucket')
        ),
      });
      expect(current?.is_enabled).toBe(false);
    });
    const caller = await createCallerForUser(testUser.id);

    await caller.organizations.reviewAgent.toggleReviewAgent({
      organizationId: organization.id,
      platform: 'bitbucket',
      isEnabled: false,
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.owned_by_organization_id, organization.id),
        eq(agent_configs.platform, 'bitbucket')
      ),
    });
    expect(stored?.is_enabled).toBe(false);
    expect(stored?.config).toEqual(
      expect.objectContaining({ selected_repository_ids: [BITBUCKET_REPOSITORY_UUID] })
    );
    expect(mockDeleteBitbucketCodeReviewWorkspaceWebhooksBestEffort).toHaveBeenCalledTimes(1);
  });

  it('rejects personal Bitbucket Code Reviewer config and toggle procedures', async () => {
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.personalReviewAgent.getReviewConfig({ platform: 'bitbucket' as 'github' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.personalReviewAgent.saveReviewConfig({
        platform: 'bitbucket' as 'github',
        reviewStyle: 'balanced',
        focusAreas: [],
        modelSlug: 'test-model',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.personalReviewAgent.toggleReviewAgent({
        platform: 'bitbucket' as 'github',
        isEnabled: true,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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

  it('does not enable Code Reviewer when a fresh personal config is saved without isEnabled', async () => {
    const caller = await createCallerForUser(testUser.id);

    // No pre-existing agent_configs row: this sub-setting save creates it.
    // Regression guard — the insert default used to be `?? true`, which
    // silently turned on auto-reviews the moment a user edited any setting.
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
      repositorySelectionMode: 'selected',
      selectedRepositoryIds: [101, 202],
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
        selected_repository_ids: [101, 202],
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
  let organization: Organization;
  const usageIds: string[] = [];

  beforeAll(async () => {
    testUser = await insertTestUser();
    organization = await createTestOrganization('Review Retry Org', testUser.id, 0, {}, false);
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
    await db
      .delete(agent_configs)
      .where(
        or(
          eq(agent_configs.owned_by_user_id, testUser.id),
          eq(agent_configs.owned_by_organization_id, organization.id)
        )
      );
    mockCancelReview.mockReset();
    mockTryDispatchPendingReviews.mockReset();
    mockGetBlobContent.mockReset();
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, organization.id));
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

  async function insertEnabledBitbucketOrganizationConfig() {
    await db.insert(agent_configs).values({
      owned_by_organization_id: organization.id,
      agent_type: 'code_review',
      platform: 'bitbucket',
      config: { disable_review_md: true },
      is_enabled: true,
      runtime_state: {},
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

  it('returns the selected model for an in-flight review before usage is persisted', async () => {
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'github',
      config: { model_slug: 'openai/gpt-5' },
      is_enabled: true,
      runtime_state: {},
      created_by: testUser.id,
    });
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues(testUser.id, 'running', {
          session_id: 'agent-running',
          cli_session_id: 'ses_running',
          model: null,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.codeReviews.get({ reviewId: review.id });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        review: expect.objectContaining({
          model: 'openai/gpt-5',
          session_id: 'agent-running',
        }),
      })
    );
  });

  it('does not replace a historical review model with the current config', async () => {
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'github',
      config: { model_slug: 'openai/gpt-5' },
      is_enabled: true,
      runtime_state: {},
      created_by: testUser.id,
    });
    const sessionId = `ses_router_model_${crypto.randomUUID()}`;
    const usageId = crypto.randomUUID();
    usageIds.push(usageId);
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues(testUser.id, 'completed', {
          cli_session_id: sessionId,
          model: null,
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
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
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
        review: expect.objectContaining({
          model: 'anthropic/claude-sonnet-4.6',
        }),
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

  it('parallel retriggers dispatch once and the second is a conflict', async () => {
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

    // Pre-create the terminal attempt so both retriggers find an existing attempt and race
    // only on the status CAS (avoiding a concurrent attempt-creation race).
    await db.insert(cloud_agent_code_review_attempts).values({
      code_review_id: review.id,
      attempt_number: 1,
      session_id: 'agent-first',
      cli_session_id: 'ses_first',
      status: 'failed',
      terminal_reason: 'sandbox_error',
    });

    const caller = await createCallerForUser(testUser.id);

    const results = await Promise.allSettled([
      caller.codeReviews.retrigger({ reviewId: review.id }),
      caller.codeReviews.retrigger({ reviewId: review.id }),
    ]);

    // Exactly one call succeeds. The loser is either a CONFLICT (it reached the
    // status CAS and lost) or a BAD_REQUEST (it read 'pending' before the CAS
    // ran). Both are non-success outcomes; the test must not depend on which one.
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<SuccessResult<{ message: string }>> =>
        r.status === 'fulfilled'
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].value.success).toBe(true);

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(['CONFLICT', 'BAD_REQUEST']).toContain((rejected[0].reason as { code?: string }).code);

    // Exactly one dispatch and one retry attempt, regardless of which call won.
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledTimes(1);

    const attempts = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id));
    const retryAttempts = attempts.filter(attempt => attempt.retry_reason === 'manual_retrigger');
    expect(retryAttempts).toHaveLength(1);
  });

  it('retries Bitbucket with its platform preserved and a fresh session attempt', async () => {
    await insertEnabledBitbucketOrganizationConfig();
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues(testUser.id, 'failed', {
          owned_by_user_id: null,
          owned_by_organization_id: organization.id,
          platform: 'bitbucket',
          session_id: 'agent-old-bitbucket',
          cli_session_id: 'ses_old_bitbucket',
          error_message: 'Container shutdown: SIGTERM',
          terminal_reason: 'sandbox_error',
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    const caller = await createCallerForUser(testUser.id);
    await caller.codeReviews.retrigger({ reviewId: review.id });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });
    const attempts = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id));
    const retryAttempt = attempts.find(attempt => attempt.retry_reason === 'manual_retrigger');

    expect(storedReview).toEqual(
      expect.objectContaining({
        platform: 'bitbucket',
        status: 'pending',
        session_id: null,
        cli_session_id: null,
      })
    );
    expect(retryAttempt).toEqual(
      expect.objectContaining({ status: 'pending', session_id: null, cli_session_id: null })
    );
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledWith({
      type: 'org',
      id: organization.id,
      userId: testUser.id,
    });
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

describe('review agent config repository model overrides', () => {
  let testUser: User;
  let organization: Organization;

  beforeAll(async () => {
    testUser = await insertTestUser();
    organization = await createTestOrganization('Override Config Org', testUser.id, 0, {}, false);
  });

  afterEach(async () => {
    await db
      .delete(agent_configs)
      .where(
        or(
          eq(agent_configs.owned_by_user_id, testUser.id),
          eq(agent_configs.owned_by_organization_id, organization.id)
        )
      );
  });

  it('round-trips personal overrides independent of the selected repositories', async () => {
    const caller = await createCallerForUser(testUser.id);

    await caller.personalReviewAgent.saveReviewConfig({
      platform: 'github',
      reviewStyle: 'balanced',
      focusAreas: [],
      modelSlug: 'test-model',
      repositorySelectionMode: 'selected',
      selectedRepositoryIds: [101],
      repositoryModelOverrides: [
        {
          repositoryId: 101,
          repoFullName: 'acme/api',
          modelSlug: 'openai/gpt-5',
          thinkingEffort: 'high',
        },
        // 202 is not in the trigger selection but overrides are independent of it.
        {
          repositoryId: 202,
          repoFullName: 'acme/other',
          modelSlug: 'openai/gpt-5',
          thinkingEffort: null,
        },
      ],
      autoConfigureWebhooks: false,
    });

    const returned = await caller.personalReviewAgent.getReviewConfig({ platform: 'github' });
    expect(returned.repositoryModelOverrides).toEqual([
      {
        repositoryId: 101,
        repoFullName: 'acme/api',
        modelSlug: 'openai/gpt-5',
        thinkingEffort: 'high',
      },
      {
        repositoryId: 202,
        repoFullName: 'acme/other',
        modelSlug: 'openai/gpt-5',
        thinkingEffort: null,
      },
    ]);
  });

  it('keeps personal overrides in all-repositories mode', async () => {
    const caller = await createCallerForUser(testUser.id);

    await caller.personalReviewAgent.saveReviewConfig({
      platform: 'github',
      reviewStyle: 'balanced',
      focusAreas: [],
      modelSlug: 'test-model',
      repositorySelectionMode: 'all',
      selectedRepositoryIds: [],
      repositoryModelOverrides: [
        {
          repositoryId: 101,
          repoFullName: 'acme/api',
          modelSlug: 'openai/gpt-5',
          thinkingEffort: null,
        },
      ],
      autoConfigureWebhooks: false,
    });

    const returned = await caller.personalReviewAgent.getReviewConfig({ platform: 'github' });
    expect(returned.repositoryModelOverrides).toEqual([
      {
        repositoryId: 101,
        repoFullName: 'acme/api',
        modelSlug: 'openai/gpt-5',
        thinkingEffort: null,
      },
    ]);
  });

  it('clears personal overrides when an empty list is saved', async () => {
    const caller = await createCallerForUser(testUser.id);
    const saveWith = (
      repositoryModelOverrides: Array<{
        repositoryId: number;
        repoFullName: string;
        modelSlug: string;
        thinkingEffort: string | null;
      }>
    ) =>
      caller.personalReviewAgent.saveReviewConfig({
        platform: 'github',
        reviewStyle: 'balanced',
        focusAreas: [],
        modelSlug: 'test-model',
        repositorySelectionMode: 'all',
        selectedRepositoryIds: [],
        repositoryModelOverrides,
        autoConfigureWebhooks: false,
      });

    await saveWith([
      {
        repositoryId: 101,
        repoFullName: 'acme/api',
        modelSlug: 'openai/gpt-5',
        thinkingEffort: null,
      },
    ]);
    await saveWith([]);

    const returned = await caller.personalReviewAgent.getReviewConfig({ platform: 'github' });
    expect(returned.repositoryModelOverrides).toEqual([]);
  });

  it('round-trips organization github overrides independent of the selection', async () => {
    const caller = await createCallerForUser(testUser.id);

    await caller.organizations.reviewAgent.saveReviewConfig({
      organizationId: organization.id,
      platform: 'github',
      reviewStyle: 'balanced',
      focusAreas: [],
      modelSlug: 'test-model',
      repositorySelectionMode: 'selected',
      selectedRepositoryIds: [101],
      repositoryModelOverrides: [
        {
          repositoryId: 101,
          repoFullName: 'acme/api',
          modelSlug: 'openai/gpt-5',
          thinkingEffort: null,
        },
        {
          repositoryId: 202,
          repoFullName: 'acme/other',
          modelSlug: 'openai/gpt-5',
          thinkingEffort: null,
        },
      ],
      autoConfigureWebhooks: false,
    });

    const returned = await caller.organizations.reviewAgent.getReviewConfig({
      organizationId: organization.id,
      platform: 'github',
    });
    expect(returned.repositoryModelOverrides).toEqual([
      {
        repositoryId: 101,
        repoFullName: 'acme/api',
        modelSlug: 'openai/gpt-5',
        thinkingEffort: null,
      },
      {
        repositoryId: 202,
        repoFullName: 'acme/other',
        modelSlug: 'openai/gpt-5',
        thinkingEffort: null,
      },
    ]);
  });

  it('rejects duplicate repository overrides for the same repo', async () => {
    const caller = await createCallerForUser(testUser.id);
    await expect(
      caller.personalReviewAgent.saveReviewConfig({
        platform: 'github',
        reviewStyle: 'balanced',
        focusAreas: [],
        modelSlug: 'test-model',
        repositorySelectionMode: 'all',
        selectedRepositoryIds: [],
        repositoryModelOverrides: [
          {
            repositoryId: 101,
            repoFullName: 'acme/api',
            modelSlug: 'openai/gpt-5',
            thinkingEffort: null,
          },
          {
            repositoryId: 101,
            repoFullName: 'acme/api',
            modelSlug: 'anthropic/claude-sonnet-5',
            thinkingEffort: null,
          },
        ],
        autoConfigureWebhooks: false,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('personalReviewAgent.patchReviewConfig', () => {
  let testUser: User;

  beforeAll(async () => {
    testUser = await insertTestUser();
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
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, testUser.id));
    mockSyncWebhooksForRepositories.mockReset();
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  beforeEach(() => {
    mockGetValidGitLabToken.mockReset();
    mockSyncWebhooksForRepositories.mockReset();
    mockSyncWebhooksForRepositories.mockResolvedValue({
      result: { created: [], updated: [], deleted: [], errors: [] },
      updatedWebhooks: {},
    });
  });

  // Seeds a GitHub personal config with values that the patch should NOT
  // touch: manuallyAddedRepositories, repositoryModelOverrides, and the
  // review_memory_enabled / review_analytics_enabled feature flags. Each
  // round-trip test asserts all of these survive a mobile-shaped patch.
  async function seedPersonalGithubConfig() {
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'github',
      config: {
        review_style: 'balanced',
        focus_areas: ['bugs'],
        custom_instructions: 'be terse',
        model_slug: 'anthropic/claude-sonnet-5',
        thinking_effort: null,
        gate_threshold: 'off',
        repository_selection_mode: 'all',
        selected_repository_ids: [101, 202],
        manually_added_repositories: [
          { id: 9, name: 'manual', full_name: 'manual/repo', private: true },
        ],
        repository_model_overrides: [
          {
            repository_id: 101,
            repo_full_name: 'acme/api',
            model_slug: 'openai/gpt-5',
            thinking_effort: 'high',
          },
        ],
        disable_review_md: true,
        // Web-only setting the patch schema never carries; `false` proves
        // the patch passes it through instead of resetting to the default.
        skip_bot_pull_requests: false,
        review_memory_enabled: true,
        review_analytics_enabled: true,
      },
      is_enabled: false,
      created_by: testUser.id,
    });
  }

  // Seeds a minimal personal config with an explicit selected_repository_ids
  // array, used by the delta repository save tests (P2-GH-45c).
  async function seedPersonalSelection(selectedRepositoryIds: number[]) {
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'github',
      config: {
        review_style: 'balanced',
        focus_areas: [],
        model_slug: 'test-model',
        repository_selection_mode: 'selected',
        selected_repository_ids: selectedRepositoryIds,
      },
      is_enabled: false,
      created_by: testUser.id,
    });
  }

  it('returns NOT_FOUND when no stored personal config exists', async () => {
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.personalReviewAgent.patchReviewConfig({
        platform: 'github',
        reviewStyle: 'strict',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });
    // PATCH must not have created a row.
    expect(stored).toBeUndefined();
  });

  it('preserves manuallyAddedRepositories and repositoryModelOverrides when the patch omits them', async () => {
    await seedPersonalGithubConfig();
    const caller = await createCallerForUser(testUser.id);

    await caller.personalReviewAgent.patchReviewConfig({
      platform: 'github',
      reviewStyle: 'strict',
      focusAreas: ['security'],
      modelSlug: 'openai/gpt-5',
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });

    expect(stored?.config).toEqual(
      expect.objectContaining({
        review_style: 'strict',
        focus_areas: ['security'],
        model_slug: 'openai/gpt-5',
        // Preserved by the field-merge:
        manually_added_repositories: [
          { id: 9, name: 'manual', full_name: 'manual/repo', private: true },
        ],
        repository_model_overrides: [
          {
            repository_id: 101,
            repo_full_name: 'acme/api',
            model_slug: 'openai/gpt-5',
            thinking_effort: 'high',
          },
        ],
        selected_repository_ids: [101, 202],
        repository_selection_mode: 'all',
        gate_threshold: 'off',
        disable_review_md: true,
        // Web-only setting preserved by the patch pass-through:
        skip_bot_pull_requests: false,
        // Feature flags preserved by `preserveCodeReviewFeatureSettings`:
        review_memory_enabled: true,
        review_analytics_enabled: true,
      })
    );
  });

  it('forces GitLab repository_selection_mode to selected when the patch omits it', async () => {
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'gitlab',
      config: {
        review_style: 'balanced',
        focus_areas: [],
        model_slug: 'test-model',
        repository_selection_mode: 'all',
        selected_repository_ids: [101],
      },
      is_enabled: false,
      created_by: testUser.id,
    });
    const caller = await createCallerForUser(testUser.id);

    await caller.personalReviewAgent.patchReviewConfig({
      platform: 'gitlab',
      // `repositorySelectionMode` deliberately omitted — GitLab forcing
      // must still clamp to 'selected' post-merge.
      modelSlug: 'openai/gpt-5',
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });
    expect(stored?.config).toEqual(
      expect.objectContaining({
        repository_selection_mode: 'selected',
        model_slug: 'openai/gpt-5',
      })
    );
  });

  it('does not run GitLab webhook sync when selectedRepositoryIds is absent from the patch', async () => {
    await seedPersonalGithubConfig();
    // Switch the stored row to gitlab so the proc's gitlab branch is
    // reachable. The patch only sends focusAreas — selection is untouched,
    // so webhook sync must NOT run.
    await db
      .update(agent_configs)
      .set({ platform: 'gitlab' })
      .where(
        and(
          eq(agent_configs.agent_type, 'code_review'),
          eq(agent_configs.owned_by_user_id, testUser.id)
        )
      );
    const caller = await createCallerForUser(testUser.id);

    const result = await caller.personalReviewAgent.patchReviewConfig({
      platform: 'gitlab',
      focusAreas: ['performance'],
    });

    expect(result.success).toBe(true);
    expect(result.webhookSync).toBeNull();
    expect(mockSyncWebhooksForRepositories).not.toHaveBeenCalled();
  });

  it('runs GitLab webhook sync only when selectedRepositoryIds is present in the patch', async () => {
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'gitlab',
      config: {
        review_style: 'balanced',
        focus_areas: [],
        model_slug: 'test-model',
        repository_selection_mode: 'selected',
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
    mockGetValidGitLabToken.mockResolvedValue('gitlab-token');
    const caller = await createCallerForUser(testUser.id);

    await caller.personalReviewAgent.patchReviewConfig({
      platform: 'gitlab',
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

  // P0-B-13b: real mobile→server contract guard. The mobile
  // useSaveReviewConfig hook now sends a partial patch whose shape is
  // exactly { platform, ...editedFields } — no manuallyAddedRepositories,
  // no repositoryModelOverrides, no autoConfigureWebhooks. The server
  // PATCH must field-merge those absent keys from the stored config.
  it('preserves a config seeded with manuallyAddedRepositories + overrides when a mobile-shaped patch is applied', async () => {
    await seedPersonalGithubConfig();
    const caller = await createCallerForUser(testUser.id);

    // Mobile-shaped patch: ONLY the keys the mobile UI lets the user edit.
    // The personal PATCH schema does not even accept
    // manuallyAddedRepositories / repositoryModelOverrides /
    // autoConfigureWebhooks here — the contract guard is that the server
    // never asks for them.
    await caller.personalReviewAgent.patchReviewConfig({
      platform: 'github',
      reviewStyle: 'strict',
      focusAreas: ['security'],
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });

    // Patched fields applied.
    expect(stored?.config).toEqual(
      expect.objectContaining({
        review_style: 'strict',
        focus_areas: ['security'],
      })
    );
    // Stored fields NOT in the mobile-shaped patch must round-trip
    // unchanged. The personal schema has no council/councilEnabled, so
    // the mobile contract is specifically about manuallyAddedRepositories
    // and repositoryModelOverrides.
    expect(stored?.config).toEqual(
      expect.objectContaining({
        manually_added_repositories: [
          { id: 9, name: 'manual', full_name: 'manual/repo', private: true },
        ],
        repository_model_overrides: [
          {
            repository_id: 101,
            repo_full_name: 'acme/api',
            model_slug: 'openai/gpt-5',
            thinking_effort: 'high',
          },
        ],
      })
    );
    // Other stored fields that the mobile client never read or sent must
    // also be preserved.
    expect(stored?.config).toEqual(
      expect.objectContaining({
        selected_repository_ids: [101, 202],
        repository_selection_mode: 'all',
        gate_threshold: 'off',
        disable_review_md: true,
      })
    );
  });

  // P2-GH-45c: delta repository save. The mobile delta sender lands later;
  // these tests pin the server contract: next = (stored ∪ add) \ remove,
  // remove wins on overlap, both-fields is rejected, and a delta-only patch
  // drives the GitLab webhook sync with computed next/previous arrays.
  it('applies a delta add to the stored selection', async () => {
    await seedPersonalSelection([101, 202]);
    const caller = await createCallerForUser(testUser.id);

    await caller.personalReviewAgent.patchReviewConfig({
      platform: 'github',
      selectedRepositoryDelta: { add: [303], remove: [] },
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });
    expect(stored?.config).toEqual(
      expect.objectContaining({ selected_repository_ids: [101, 202, 303] })
    );
  });

  it('applies a delta remove to the stored selection', async () => {
    await seedPersonalSelection([101, 202, 303]);
    const caller = await createCallerForUser(testUser.id);

    await caller.personalReviewAgent.patchReviewConfig({
      platform: 'github',
      selectedRepositoryDelta: { add: [], remove: [202] },
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });
    expect(stored?.config).toEqual(
      expect.objectContaining({ selected_repository_ids: [101, 303] })
    );
  });

  it('lets remove win over add on an overlapping delta', async () => {
    await seedPersonalSelection([101, 202]);
    const caller = await createCallerForUser(testUser.id);

    await caller.personalReviewAgent.patchReviewConfig({
      platform: 'github',
      selectedRepositoryDelta: { add: [202, 303], remove: [202] },
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });
    expect(stored?.config).toEqual(
      expect.objectContaining({ selected_repository_ids: [101, 303] })
    );
  });

  it('applies a delta add to an empty stored selection', async () => {
    await seedPersonalSelection([]);
    const caller = await createCallerForUser(testUser.id);

    await caller.personalReviewAgent.patchReviewConfig({
      platform: 'github',
      selectedRepositoryDelta: { add: [505], remove: [] },
    });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });
    expect(stored?.config).toEqual(expect.objectContaining({ selected_repository_ids: [505] }));
  });

  it('rejects a patch carrying both selectedRepositoryIds and selectedRepositoryDelta', async () => {
    await seedPersonalSelection([101, 202]);
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.personalReviewAgent.patchReviewConfig({
        platform: 'github',
        selectedRepositoryIds: [101],
        selectedRepositoryDelta: { add: [303], remove: [] },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const stored = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.owned_by_user_id, testUser.id)
      ),
    });
    expect(stored?.config).toEqual(
      expect.objectContaining({ selected_repository_ids: [101, 202] })
    );
  });

  it('runs GitLab webhook sync with computed next/previous arrays on a delta-only patch', async () => {
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'gitlab',
      config: {
        review_style: 'balanced',
        focus_areas: [],
        model_slug: 'test-model',
        repository_selection_mode: 'selected',
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
    mockGetValidGitLabToken.mockResolvedValue('gitlab-token');
    const caller = await createCallerForUser(testUser.id);

    await caller.personalReviewAgent.patchReviewConfig({
      platform: 'gitlab',
      selectedRepositoryDelta: { add: [303], remove: [101] },
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
});

// ============================================================================
// P1-D-32: GitLab webhook secret handling on the personal surface.
//
// Regression guards for two security fixes:
//   1. `personalReviewAgent.getGitLabStatus` MUST NOT return the webhook
//      secret. (Lower risk than the org path because the caller is the
//      secret owner, but still a status-read leak that this slice removes.)
//   2. `gitlab.regenerateWebhookSecret` MUST re-sync the Kilo-managed
//      webhooks so the integration keeps working with the new secret. The
//      previous shape persisted a new secret and never re-synced, so live
//      webhooks kept carrying the old secret and stopped validating.
// ============================================================================

async function seedPersonalGitLabIntegration(userId: string, metadata: Record<string, unknown>) {
  await db.insert(platform_integrations).values({
    owned_by_user_id: userId,
    platform: 'gitlab',
    integration_type: 'oauth',
    integration_status: 'active',
    platform_installation_id: `inst-${crypto.randomUUID()}`,
    metadata: { ...metadata, webhook_secret: 'old-secret-do-not-leak' },
  });
}

async function readPersonalWebhookSecret(userId: string): Promise<string | undefined> {
  const row = await db.query.platform_integrations.findFirst({
    where: and(
      eq(platform_integrations.owned_by_user_id, userId),
      eq(platform_integrations.platform, 'gitlab')
    ),
  });
  return (row?.metadata as Record<string, unknown> | null)?.webhook_secret as string | undefined;
}

async function readPersonalConfiguredWebhooks(
  userId: string
): Promise<Record<string, { hook_id: number; created_at: string; updated_at?: string }>> {
  const row = await db.query.platform_integrations.findFirst({
    where: and(
      eq(platform_integrations.owned_by_user_id, userId),
      eq(platform_integrations.platform, 'gitlab')
    ),
  });
  return (
    ((row?.metadata as Record<string, unknown> | null)?.configured_webhooks as
      | Record<string, { hook_id: number; created_at: string; updated_at?: string }>
      | undefined) ?? {}
  );
}

describe('personalReviewAgent.getGitLabStatus P1-D-32 (omits webhook secret)', () => {
  let testUser: User;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  beforeEach(() => {
    mockGetValidGitLabToken.mockReset();
    mockSyncWebhooksForRepositories.mockReset();
  });

  afterEach(async () => {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, testUser.id));
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  it('returns the integration shape WITHOUT webhookSecret for the self caller', async () => {
    await seedPersonalGitLabIntegration(testUser.id, {
      gitlab_instance_url: 'https://gitlab.example.com',
      configured_webhooks: { '101': { hook_id: 9001, created_at: '2026-01-01T00:00:00Z' } },
    });

    const caller = await createCallerForUser(testUser.id);
    const status = await caller.personalReviewAgent.getGitLabStatus();

    expect(status.connected).toBe(true);
    expect(status.integration).toBeDefined();
    // Regression guard: the secret must NEVER appear in the status
    // payload, even for the secret's owner. If this assertion fails,
    // the leak has been re-introduced.
    expect(status.integration).not.toHaveProperty('webhookSecret');
    expect((status.integration as Record<string, unknown>).webhookSecret).toBeUndefined();
    // The rest of the shape is preserved (non-secret fields still ship;
    // account/repositorySelection/installedAt pass through verbatim from the
    // stored integration row regardless of their concrete values).
    expect(status.integration).toEqual(
      expect.objectContaining({
        isValid: true,
        instanceUrl: 'https://gitlab.example.com',
      })
    );
    expect(status.integration).toHaveProperty('accountLogin');
    expect(status.integration).toHaveProperty('repositorySelection');
    expect(status.integration).toHaveProperty('installedAt');
  });
});

describe('gitlab.regenerateWebhookSecret P1-D-32 (self-only, re-syncs)', () => {
  let testUser: User;
  let otherUser: User;

  beforeAll(async () => {
    testUser = await insertTestUser();
    otherUser = await insertTestUser();
  });

  beforeEach(() => {
    mockGetValidGitLabToken.mockReset();
    mockSyncWebhooksForRepositories.mockReset();
    // Default sync outcome: every currently-configured repo was "updated"
    // (mirrors the `previous=[]` "treat all as added" path used by rotate).
    mockSyncWebhooksForRepositories.mockImplementation(
      async (_token, _secret, selectedIds, _previous, configuredWebhooks) => {
        const updatedWebhooks: Record<
          string,
          { hook_id: number; created_at: string; updated_at?: string }
        > = {};
        for (const id of selectedIds) {
          const existing = configuredWebhooks[String(id)];
          updatedWebhooks[String(id)] = {
            hook_id: existing?.hook_id ?? 1000 + Number(id),
            created_at: existing?.created_at ?? new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        }
        return {
          result: {
            created: [],
            updated: selectedIds.map((id: number) => ({ projectId: id, hookId: 1000 + id })),
            deleted: [],
            errors: [],
          },
          updatedWebhooks,
        };
      }
    );
    mockGetValidGitLabToken.mockResolvedValue('gitlab-access-token');
  });

  afterEach(async () => {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, testUser.id));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, otherUser.id));
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, [testUser.id, otherUser.id]));
  });

  it('persists a NEW secret, re-syncs webhooks with the new secret and previous=[]', async () => {
    const configured = {
      '101': { hook_id: 9001, created_at: '2026-01-01T00:00:00Z' },
      '202': { hook_id: 9002, created_at: '2026-01-02T00:00:00Z' },
    };
    await seedPersonalGitLabIntegration(testUser.id, {
      gitlab_instance_url: 'https://gitlab.example.com',
      configured_webhooks: configured,
    });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.gitlab.regenerateWebhookSecret();

    expect(typeof result.webhookSecret).toBe('string');
    expect(result.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.webhookSecret).not.toBe('old-secret-do-not-leak');

    expect(mockSyncWebhooksForRepositories).toHaveBeenCalledTimes(1);
    expect(mockSyncWebhooksForRepositories).toHaveBeenCalledWith(
      'gitlab-access-token',
      result.webhookSecret,
      [101, 202],
      [],
      configured,
      'https://gitlab.example.com'
    );
    expect(result.webhookSync.updated).toBe(2);
    expect(result.webhookSync.created).toBe(0);
    expect(result.webhookSync.deleted).toBe(0);
    expect(result.webhookSync.errors).toEqual([]);
    expect(result.configuredWebhookCount).toBe(2);

    // Persistence: metadata.webhook_secret is the NEW secret and
    // metadata.configured_webhooks was updated with the sync output.
    expect(await readPersonalWebhookSecret(testUser.id)).toBe(result.webhookSecret);
    const stored = await readPersonalConfiguredWebhooks(testUser.id);
    expect(Object.keys(stored).sort()).toEqual(['101', '202']);
    expect(stored['101']?.updated_at).toBeDefined();
    expect(stored['202']?.updated_at).toBeDefined();
  });

  it('with empty configured_webhooks returns the new secret and does NOT call sync', async () => {
    await seedPersonalGitLabIntegration(testUser.id, {
      gitlab_instance_url: 'https://gitlab.example.com',
      configured_webhooks: {},
    });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.gitlab.regenerateWebhookSecret();

    expect(result.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.webhookSync).toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      errors: [],
    });
    expect(result.configuredWebhookCount).toBe(0);
    expect(mockSyncWebhooksForRepositories).not.toHaveBeenCalled();
    // No token lookup needed when there are no webhooks to re-sync.
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
    expect(await readPersonalWebhookSecret(testUser.id)).toBe(result.webhookSecret);
  });

  it('is self-only: the callers own integration is rotated, never another users', async () => {
    const configuredSelf = { '1': { hook_id: 1, created_at: '2026-01-01T00:00:00Z' } };
    const configuredOther = { '2': { hook_id: 2, created_at: '2026-01-01T00:00:00Z' } };
    await seedPersonalGitLabIntegration(testUser.id, {
      gitlab_instance_url: 'https://gitlab.com',
      configured_webhooks: configuredSelf,
    });
    await seedPersonalGitLabIntegration(otherUser.id, {
      gitlab_instance_url: 'https://gitlab.com',
      configured_webhooks: configuredOther,
    });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.gitlab.regenerateWebhookSecret();

    // Self was rotated; other user is untouched.
    expect(await readPersonalWebhookSecret(testUser.id)).toBe(result.webhookSecret);
    expect(await readPersonalWebhookSecret(otherUser.id)).toBe('old-secret-do-not-leak');

    // Sync was called only once, for the caller's configured repo id.
    expect(mockSyncWebhooksForRepositories).toHaveBeenCalledTimes(1);
    expect(mockSyncWebhooksForRepositories).toHaveBeenCalledWith(
      'gitlab-access-token',
      result.webhookSecret,
      [1],
      [],
      configuredSelf,
      'https://gitlab.com'
    );
  });

  it('persists the NEW secret even when the webhook re-sync throws (no lost-secret state)', async () => {
    const configured = {
      '404': { hook_id: 9040, created_at: '2026-03-01T00:00:00Z' },
    };
    await seedPersonalGitLabIntegration(testUser.id, {
      gitlab_instance_url: 'https://gitlab.example.com',
      configured_webhooks: configured,
    });
    mockSyncWebhooksForRepositories.mockRejectedValueOnce(new Error('gitlab responded 500'));

    const caller = await createCallerForUser(testUser.id);
    // Must not throw: losing the just-rotated secret while GitLab may
    // already carry it would strand the caller's integration.
    const result = await caller.gitlab.regenerateWebhookSecret();

    expect(result.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.webhookSecret).not.toBe('old-secret-do-not-leak');
    expect(result.webhookSync.errors).toHaveLength(1);
    expect(result.webhookSync.updated).toBe(0);
    // New secret persisted for manual recovery; surfaced error omits it.
    expect(await readPersonalWebhookSecret(testUser.id)).toBe(result.webhookSecret);
    expect(JSON.stringify(result.webhookSync.errors)).not.toContain(result.webhookSecret);
  });

  it('persists the NEW secret even when the access-token lookup throws', async () => {
    const configured = {
      '505': { hook_id: 9050, created_at: '2026-03-02T00:00:00Z' },
    };
    await seedPersonalGitLabIntegration(testUser.id, {
      gitlab_instance_url: 'https://gitlab.example.com',
      configured_webhooks: configured,
    });
    mockGetValidGitLabToken.mockRejectedValueOnce(new Error('token expired'));

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.gitlab.regenerateWebhookSecret();

    expect(result.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.webhookSync.errors).toHaveLength(1);
    expect(mockSyncWebhooksForRepositories).not.toHaveBeenCalled();
    expect(await readPersonalWebhookSecret(testUser.id)).toBe(result.webhookSecret);
  });
});
