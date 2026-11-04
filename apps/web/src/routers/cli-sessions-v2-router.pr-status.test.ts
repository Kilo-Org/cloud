import type { CliSessionV2, User } from '@kilocode/db/schema';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import type * as TrpcServerModule from '@trpc/server';
import type * as ZodModule from 'zod';
import { TRPCError } from '@trpc/server';
import type { PrStatus } from '@/lib/integrations/platforms/github/pr-status';
import type { cliSessionsV2Router } from './cli-sessions-v2-router';

const USER_ID = 'test-user-pr-status';
const SESSION_ID = 'ses_pr_status_123456789012345';
const ORGANIZATION_ID = '9a283301-b75d-4375-a1ba-e319a02e18b7';
const GIT_URL = 'https://github.com/acme/widgets';
const PR_URL = `${GIT_URL}/pull/7`;
const BRANCH = 'feature/pr-status';
const ORIGINAL_HEAD_SHA = '1111111111111111111111111111111111111111';
const FRESH_HEAD_SHA = '3333333333333333333333333333333333333333';
const BASE_SHA = '2222222222222222222222222222222222222222';
const VERIFIED_AT = '2026-01-01T00:00:00.000Z';

const mockLimit = jest.fn();
const mockWhere = jest.fn();
const mockFrom = jest.fn();
const mockSelect = jest.fn();
const mockUpdate = jest.fn();
const mockInsert = jest.fn();
const mockDelete = jest.fn();

const selectChain = { from: mockFrom, where: mockWhere, limit: mockLimit };
mockFrom.mockReturnValue(selectChain);
mockWhere.mockReturnValue(selectChain);
mockSelect.mockReturnValue(selectChain);

const dbMock = {
  select: mockSelect,
  update: mockUpdate,
  insert: mockInsert,
  delete: mockDelete,
};

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  get db() {
    return dbMock;
  },
}));

jest.mock('@kilocode/web-shared/lib/trpc/init', () => {
  const { initTRPC } = jest.requireActual<typeof TrpcServerModule>('@trpc/server');
  const trpc = initTRPC.context<TRPCContext>().create();

  return {
    baseProcedure: trpc.procedure,
    createTRPCRouter: trpc.router,
    createCallerFactory: trpc.createCallerFactory,
  };
});

const mockEnsureOrganizationAccess = jest.fn();
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: (...args: unknown[]) => mockEnsureOrganizationAccess(...args),
}));

const mockResolveGitHubRepositoryForOwner = jest.fn();
jest.mock('@/lib/slack-bot/github-repository-context', () => ({
  resolveGitHubRepositoryForOwner: (...args: unknown[]) =>
    mockResolveGitHubRepositoryForOwner(...args),
}));

const mockGetGitHubIntegrationById = jest.fn();
const mockGetIntegrationForOwner = jest.fn();
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getGitHubIntegrationById: (...args: unknown[]) => mockGetGitHubIntegrationById(...args),
  getIntegrationForOwner: (...args: unknown[]) => mockGetIntegrationForOwner(...args),
}));

const mockFetchPullRequestStatus = jest.fn();
jest.mock('@/lib/integrations/platforms/github/pr-status', () => {
  const { z } = jest.requireActual<typeof ZodModule>('zod');
  return {
    prStatusSchema: z.object({}).passthrough(),
    fetchPullRequestStatus: (...args: unknown[]) => mockFetchPullRequestStatus(...args),
  };
});

const mockCaptureException = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

jest.mock('@/lib/cloud-agent/watch-pr', () => {
  const { z } = jest.requireActual<typeof ZodModule>('zod');
  const passthroughSchema = z.object({}).passthrough();
  return {
    changeWatchPr: jest.fn(),
    enableWatchPr: jest.fn(),
    getWatchPr: jest.fn(),
    getPrWatchOptions: jest.fn(),
    recheckWatchPr: jest.fn(),
    watchPrEnableSchema: passthroughSchema,
    watchPrMutationSchema: passthroughSchema,
    watchPrQuerySchema: passthroughSchema,
  };
});

const mockFetchPullRequestByNumber = jest.fn();
const mockIsRateLimitError = jest.fn();
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchPullRequestByNumber: (...args: unknown[]) => mockFetchPullRequestByNumber(...args),
  fetchPullRequestReviewDecision: jest.fn(),
  GitHubRateLimitError: class GitHubRateLimitError extends Error {},
  isGitHubRateLimitError: (...args: unknown[]) => mockIsRateLimitError(...args),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(() => ({
    getSession: jest.fn(),
    getPreparationAttempts: jest.fn(),
    deleteSession: jest.fn(),
    deleteHostedWorkspaceSession: jest.fn(),
  })),
}));

jest.mock('@kilocode/web-shared/lib/tokens', () => ({
  generateApiToken: jest.fn(() => 'test-api-token'),
  generateInternalServiceToken: jest.fn(() => 'test-internal-token'),
  generateBoundedInternalServiceToken: jest.fn(() => 'test-bounded-token'),
}));

jest.mock('@/lib/auth/resource-delegation', () => ({
  createControlTokenForRequest: jest.fn(async () => ({ token: 'test-control-token' })),
}));

jest.mock('@/lib/session-ingest-client', () => ({
  fetchSessionSnapshot: jest.fn(),
  fetchSessionMessagesPage: jest.fn(),
  fetchSessionDiff: jest.fn(),
  deleteSession: jest.fn(),
  shareSession: jest.fn(),
  unshareSession: jest.fn(),
  SessionShareTooLargeError: class SessionShareTooLargeError extends Error {},
}));

jest.mock('@/lib/cloud-agent/session-events', () => ({
  notifyCliSessionRenamed: jest.fn(),
}));

jest.mock('@/lib/integrations/platforms/github/batch-review-decisions', () => ({
  triggerBatchReviewDecisionFetchIfNeeded: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/admin/admin-access-log', () => ({
  recordKiloAdminElevation: jest.fn(),
  UNSCOPED_TARGET: 'unscoped',
}));

jest.mock('next/server', () => ({
  after: jest.fn(),
}));

type PrStatusCaller = ReturnType<typeof cliSessionsV2Router.createCaller>;

const user = { id: USER_ID } as User;

let createCaller: (ctx: TRPCContext) => PrStatusCaller;
let baseSession: CliSessionV2;

function makeSession(overrides: Partial<CliSessionV2> = {}): CliSessionV2 {
  return { ...baseSession, ...overrides };
}

function makeStatus(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    url: PR_URL,
    number: 7,
    state: 'open',
    title: 'Add PR status',
    headSha: ORIGINAL_HEAD_SHA,
    baseSha: BASE_SHA,
    headRef: BRANCH,
    baseRef: 'main',
    baseRepoFullName: 'acme/widgets',
    headRepoFullName: 'acme/widgets',
    reviewDecision: 'approved',
    mergeable: true,
    mergeableState: 'clean',
    checks: {
      total: 2,
      passed: 1,
      failed: 0,
      pending: 1,
      skipped: 0,
      unknown: 0,
      truncated: false,
    },
    unresolvedThreads: 0,
    threadsTruncated: false,
    unavailable: [],
    fetchedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

const repository = {
  id: 'repository-1',
  full_name: 'acme/widgets',
  private: false,
  githubIntegrationId: 'integration-1',
  githubAppType: 'lite' as const,
};

const integration = {
  id: 'integration-1',
  platform_installation_id: 'installation-1',
  github_app_type: 'lite' as const,
};

beforeAll(async () => {
  baseSession = {
    session_id: SESSION_ID,
    kilo_user_id: USER_ID,
    version: 0,
    title: 'PR status session',
    public_id: null,
    parent_session_id: null,
    organization_id: null,
    cloud_agent_session_id: null,
    profile_id: null,
    cloud_agent_session_scope_id: null,
    cloud_agent_worktree_id: null,
    created_on_platform: 'cloud-agent-web',
    git_url: GIT_URL,
    git_branch: BRANCH,
    platform: 'github',
    pr_url: PR_URL,
    pr_number: 7,
    pr_head_ref: BRANCH,
    pr_head_sha: ORIGINAL_HEAD_SHA,
    pr_link_verified_at: VERIFIED_AT,
    status: null,
    status_updated_at: null,
    status_transition_id: null,
    last_activity_at: null,
    total_cost_microdollars: null,
    live_summary: null,
    briefing_excerpt: null,
    briefing_excerpt_scope_changed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  const { createCallerFactory } = await import('@kilocode/web-shared/lib/trpc/init');
  const { cliSessionsV2Router } = await import('./cli-sessions-v2-router');
  createCaller = createCallerFactory(cliSessionsV2Router);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLimit.mockReset().mockResolvedValue([baseSession]);
  mockEnsureOrganizationAccess.mockReset().mockResolvedValue(undefined);
  mockResolveGitHubRepositoryForOwner.mockReset().mockResolvedValue(repository);
  mockGetGitHubIntegrationById.mockReset().mockResolvedValue(integration);
  mockFetchPullRequestStatus.mockReset().mockResolvedValue(makeStatus());
  mockGetIntegrationForOwner.mockReset().mockResolvedValue(null);
  mockIsRateLimitError.mockReset().mockReturnValue(false);
});

function getStatus(prUrl = PR_URL) {
  return createCaller({ user }).getAssociatedPullRequestStatus({
    sessionId: SESSION_ID,
    prUrl,
  });
}

describe('cliSessionsV2.getAssociatedPullRequestStatus', () => {
  it('returns NOT_FOUND for a session the caller does not own', async () => {
    mockLimit.mockResolvedValue([]);

    await expect(getStatus()).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockResolveGitHubRepositoryForOwner).not.toHaveBeenCalled();
    expect(mockGetGitHubIntegrationById).not.toHaveBeenCalled();
    expect(mockFetchPullRequestStatus).not.toHaveBeenCalled();
  });

  it('checks organization access before resolving the repository or calling GitHub', async () => {
    mockLimit.mockResolvedValue([makeSession({ organization_id: ORGANIZATION_ID })]);
    mockEnsureOrganizationAccess.mockRejectedValue(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'Organization access denied' })
    );

    await expect(getStatus()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ user }),
      ORGANIZATION_ID
    );
    expect(mockResolveGitHubRepositoryForOwner).not.toHaveBeenCalled();
    expect(mockFetchPullRequestStatus).not.toHaveBeenCalled();
  });

  it('checks organization access before GitHub calls for an authorized organization session', async () => {
    mockLimit.mockResolvedValue([makeSession({ organization_id: ORGANIZATION_ID })]);

    await expect(getStatus()).resolves.toEqual(makeStatus());

    expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ user }),
      ORGANIZATION_ID
    );
    expect(mockEnsureOrganizationAccess.mock.invocationCallOrder[0]).toBeLessThan(
      mockResolveGitHubRepositoryForOwner.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(mockResolveGitHubRepositoryForOwner).toHaveBeenCalledWith(
      { type: 'org', id: ORGANIZATION_ID },
      'acme/widgets',
      'agent'
    );
  });

  it('rejects an unverified session link before any GitHub call', async () => {
    mockLimit.mockResolvedValue([makeSession({ pr_link_verified_at: null })]);

    await expect(getStatus()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mockResolveGitHubRepositoryForOwner).not.toHaveBeenCalled();
    expect(mockFetchPullRequestStatus).not.toHaveBeenCalled();
  });

  it('rejects an expected PR URL that differs from the verified session link', async () => {
    await expect(getStatus(`${GIT_URL}/pull/8`)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    expect(mockResolveGitHubRepositoryForOwner).not.toHaveBeenCalled();
    expect(mockFetchPullRequestStatus).not.toHaveBeenCalled();
  });

  it('rejects a verified PR link that no longer matches the session repository', async () => {
    mockLimit.mockResolvedValue([
      makeSession({ git_url: 'https://github.com/acme/other-repository' }),
    ]);

    await expect(getStatus()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mockResolveGitHubRepositoryForOwner).not.toHaveBeenCalled();
    expect(mockFetchPullRequestStatus).not.toHaveBeenCalled();
  });

  it('resolves the personal owner repository for agent use and passes the lite app association through', async () => {
    const status = makeStatus();

    await expect(getStatus()).resolves.toEqual(status);

    expect(mockResolveGitHubRepositoryForOwner).toHaveBeenCalledWith(
      { type: 'user', id: USER_ID },
      'acme/widgets',
      'agent'
    );
    expect(mockGetGitHubIntegrationById).toHaveBeenCalledWith(
      { type: 'user', id: USER_ID },
      'integration-1'
    );
    expect(mockFetchPullRequestStatus).toHaveBeenCalledWith({
      installationId: 'installation-1',
      integrationId: 'integration-1',
      appType: 'lite',
      owner: 'acme',
      repo: 'widgets',
      number: 7,
    });
  });

  it('returns a meaningful PRECONDITION when no authorized connection exists', async () => {
    mockResolveGitHubRepositoryForOwner.mockResolvedValue(null);

    await expect(getStatus()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'No authorized GitHub connection is available for this repository',
    });

    expect(mockFetchPullRequestStatus).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('falls back to the owner connection when the cached repository inventory is missing or ambiguous', async () => {
    mockResolveGitHubRepositoryForOwner.mockResolvedValue(null);
    mockGetIntegrationForOwner.mockResolvedValue(integration);
    await expect(getStatus()).resolves.toEqual(makeStatus());
    expect(mockGetIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'user', id: USER_ID },
      'github'
    );
    expect(mockFetchPullRequestStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: integration.id,
        installationId: integration.platform_installation_id,
      })
    );
  });

  it('does not report rate limits as unexpected GitHub failures', async () => {
    mockFetchPullRequestStatus.mockRejectedValue({ status: 429 });
    mockIsRateLimitError.mockReturnValue(true);
    await expect(getStatus()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it.each([403, 404])(
    'reports GitHub access failure %s without retryable gateway errors',
    async status => {
      mockFetchPullRequestStatus.mockRejectedValue({ status });
      await expect(getStatus()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(mockCaptureException).not.toHaveBeenCalled();
    }
  );

  it('returns a safe BAD_GATEWAY when GitHub status retrieval fails', async () => {
    const githubError = new Error('upstream token=do-not-leak');
    mockFetchPullRequestStatus.mockRejectedValue(githubError);

    await expect(getStatus()).rejects.toMatchObject({
      code: 'BAD_GATEWAY',
      message: 'Could not read pull request status from GitHub. Refresh to try again.',
    });

    expect(mockCaptureException).toHaveBeenCalledWith(
      githubError,
      expect.objectContaining({
        tags: { source: 'cli-sessions-v2-router', endpoint: 'getAssociatedPullRequestStatus' },
        extra: { sessionId: SESSION_ID },
      })
    );
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('accepts a fresh PR head after the session link was verified at an older SHA', async () => {
    mockFetchPullRequestStatus.mockResolvedValue(makeStatus({ headSha: FRESH_HEAD_SHA }));

    await expect(getStatus()).resolves.toMatchObject({ headSha: FRESH_HEAD_SHA });

    expect(baseSession.pr_head_sha).toBe(ORIGINAL_HEAD_SHA);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockFetchPullRequestByNumber).not.toHaveBeenCalled();
  });

  it('rejects a fetched base repository that differs from the session repository', async () => {
    mockFetchPullRequestStatus.mockResolvedValue(
      makeStatus({ baseRepoFullName: 'other-owner/widgets' })
    );

    await expect(getStatus()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'GitHub no longer identifies this pull request as belonging to the session',
    });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('rejects a fetched head repository that differs from the session repository', async () => {
    mockFetchPullRequestStatus.mockResolvedValue(
      makeStatus({ headRepoFullName: 'someone-else/widgets' })
    );

    await expect(getStatus()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects a fetched head branch that differs from the session branch', async () => {
    mockFetchPullRequestStatus.mockResolvedValue(makeStatus({ headRef: 'other-branch' }));

    await expect(getStatus()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'GitHub no longer identifies this pull request as belonging to the session',
    });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
