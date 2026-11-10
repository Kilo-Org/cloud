import type { CliSessionV2, User } from '@kilocode/db/schema';
import { github_branch_pull_requests } from '@kilocode/db/schema';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import type * as TrpcServerModule from '@trpc/server';
import type * as ZodModule from 'zod';
import { TRPCError } from '@trpc/server';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  GitHubRateLimitError,
  type AssociatedPullRequest,
} from '@/lib/integrations/platforms/github/adapter';
import type * as SharedAdapterMock from '@/tests/setup/__mocks__/lib/integrations/platforms/github/adapter';
import {
  createEmptyPrObservations,
  type PrObservations,
} from '@/lib/integrations/platforms/github/pr-observations';
import type { cliSessionsV2Router } from './cli-sessions-v2-router';

const USER_ID = 'test-user-pr-refresh';
const SESSION_ID = 'ses_pr_refresh_123456789012345';
const ORGANIZATION_ID = '9a283301-b75d-4375-a1ba-e319a02e18b7';
const GIT_URL = 'https://github.com/acme/widgets';
const PR_URL = `${GIT_URL}/pull/7`;
const BRANCH = 'feature/pr-refresh';
const CACHED_HEAD_SHA = 'c'.repeat(40);
const FETCHED_HEAD_SHA = 'f'.repeat(40);
const WINNING_HEAD_SHA = '9'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const VERIFIED_AT = '2026-01-01T00:00:00.000Z';
const STALE_SYNCED_AT = '2026-01-01T00:00:00.000Z';
const RETRY_AT = new Date('2026-03-01T00:01:00.000Z');
const RAW_CACHE_UPDATED_AT = '2026-01-01 00:00:00.123+00';

const selectChain = {
  from: jest.fn(),
  leftJoin: jest.fn(),
  where: jest.fn(),
  limit: jest.fn(),
};
selectChain.from.mockReturnValue(selectChain);
selectChain.leftJoin.mockReturnValue(selectChain);
selectChain.where.mockReturnValue(selectChain);
const mockLimit = selectChain.limit;

const mockSelect = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockInsertValues = jest.fn();
const mockOnConflictDoUpdate = jest.fn();
const mockReturning = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();

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

const mockGetIntegrationForOwner = jest.fn();
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (...args: unknown[]) => mockGetIntegrationForOwner(...args),
}));

const mockFetchPullRequestObservations = jest.fn();
jest.mock('@/lib/integrations/platforms/github/pr-status', () => ({
  fetchPullRequestObservations: (...args: unknown[]) => mockFetchPullRequestObservations(...args),
}));

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
jest.mock('@/lib/integrations/platforms/github/adapter', () => {
  const sharedMock = jest.requireActual<typeof SharedAdapterMock>(
    '@/tests/setup/__mocks__/lib/integrations/platforms/github/adapter'
  );
  return {
    fetchPullRequestByNumber: (...args: unknown[]) => mockFetchPullRequestByNumber(...args),
    GitHubRateLimitError: sharedMock.GitHubRateLimitError,
    toGitHubRateLimitError: sharedMock.toGitHubRateLimitError,
  };
});

const mockClaimPrRefresh = jest.fn();
const mockDeferPrRefresh = jest.fn();
jest.mock('@/lib/integrations/platforms/github/pr-refresh-budget', () => ({
  claimPrRefresh: (...args: unknown[]) => mockClaimPrRefresh(...args),
  deferPrRefresh: (...args: unknown[]) => mockDeferPrRefresh(...args),
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

type RefreshCaller = ReturnType<typeof cliSessionsV2Router.createCaller>;

const user = { id: USER_ID } as User;

let createCaller: (ctx: TRPCContext) => RefreshCaller;
let baseSession: CliSessionV2;

function makeSession(overrides: Partial<CliSessionV2> = {}): CliSessionV2 {
  return { ...baseSession, ...overrides };
}

type InitialRow = {
  session: CliSessionV2;
  pr_url: string | null;
  pr_number: number | null;
  pr_state: string | null;
  pr_title: string | null;
  pr_head_sha: string | null;
  pr_observations: unknown;
  pr_last_synced_at: string | null;
  pr_review_decision: string | null;
  review_decision_pending: boolean | null;
  cache_updated_at: string | null;
};

type InitialRowOverrides = Partial<Omit<InitialRow, 'session'>> & {
  session?: Partial<CliSessionV2>;
};

function makeRow(overrides: InitialRowOverrides = {}): InitialRow {
  const { session, ...cacheOverrides } = overrides;
  return {
    session: makeSession(session),
    pr_url: null,
    pr_number: null,
    pr_state: null,
    pr_title: null,
    pr_head_sha: null,
    pr_observations: null,
    pr_last_synced_at: null,
    pr_review_decision: null,
    review_decision_pending: null,
    cache_updated_at: null,
    ...cacheOverrides,
  };
}

function makeCachedRow(overrides: InitialRowOverrides = {}): InitialRow {
  return makeRow({
    pr_url: PR_URL,
    pr_number: 7,
    pr_state: 'open',
    pr_title: 'Cached title',
    pr_head_sha: CACHED_HEAD_SHA,
    pr_last_synced_at: STALE_SYNCED_AT,
    pr_review_decision: 'approved',
    review_decision_pending: false,
    cache_updated_at: RAW_CACHE_UPDATED_AT,
    ...overrides,
  });
}

function makeFetched(overrides: Partial<AssociatedPullRequest> = {}): AssociatedPullRequest {
  return {
    number: 7,
    htmlUrl: PR_URL,
    state: 'open',
    title: 'Fetched title',
    headSha: FETCHED_HEAD_SHA,
    updatedAt: '2026-01-02T00:00:00.000Z',
    baseRepoFullName: 'acme/widgets',
    headRepoFullName: 'acme/widgets',
    headRef: BRANCH,
    baseSha: BASE_SHA,
    baseRef: 'main',
    mergeable: true,
    mergeableState: 'clean',
    ...overrides,
  };
}

function makeObservations(overrides: Partial<PrObservations> = {}): PrObservations {
  return {
    ...createEmptyPrObservations(),
    headSha: FETCHED_HEAD_SHA,
    checksObserved: true,
    checksComplete: true,
    checks: [
      {
        key: 'check:1:test',
        id: '1',
        attempt: 1,
        at: null,
        phase: 2,
        failed: false,
        outcome: 'passed',
      },
    ],
    threadsObserved: true,
    threadsComplete: true,
    threads: [{ rootId: '2', threadId: 'thread-1', state: 'unresolved' }],
    ...overrides,
  };
}

const EXPECTED_OBSERVATION_SUMMARY = {
  checks: { total: 1, failed: 0, passed: 1, pending: 0, skipped: 0, unknown: 0, complete: true },
  unresolvedThreads: 1,
  truncated: false,
  threadsComplete: true,
};

const repositoryIntegration = {
  id: 'integration-1',
  platform_installation_id: '12345',
  github_app_type: 'lite' as const,
};

beforeAll(async () => {
  baseSession = {
    session_id: SESSION_ID,
    kilo_user_id: USER_ID,
    version: 0,
    title: 'PR refresh session',
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
    pr_head_sha: null,
    pr_link_verified_at: null,
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
  selectChain.from.mockReturnValue(selectChain);
  selectChain.leftJoin.mockReturnValue(selectChain);
  selectChain.where.mockReturnValue(selectChain);
  mockSelect.mockReturnValue(selectChain);
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  mockOnConflictDoUpdate.mockReturnValue({ returning: mockReturning });
  mockReturning.mockReset();
  mockReturning.mockImplementation(async () => {
    const values = (mockInsertValues.mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
    return [
      {
        pr_url: values.pr_url,
        pr_number: values.pr_number,
        pr_state: values.pr_state,
        pr_title: values.pr_title,
        pr_head_sha: values.pr_head_sha,
        pr_observations: values.pr_observations,
        pr_last_synced_at: '2026-01-02T00:00:00.000Z',
        pr_review_decision: values.pr_review_decision ?? null,
        review_decision_pending: values.review_decision_pending === true,
      },
    ];
  });
  mockUpdate.mockReturnValue({ set: mockUpdateSet });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockResolvedValue([]);

  mockLimit.mockReset().mockResolvedValue([]);
  mockEnsureOrganizationAccess.mockReset().mockResolvedValue(undefined);
  mockGetIntegrationForOwner.mockReset().mockResolvedValue(repositoryIntegration);
  mockFetchPullRequestByNumber.mockReset();
  mockFetchPullRequestObservations.mockReset();
  mockClaimPrRefresh.mockReset().mockResolvedValue({ allowed: true });
  mockDeferPrRefresh.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function refresh() {
  return createCaller({ user }).refreshAssociatedPullRequest({ sessionId: SESSION_ID });
}

function lastUpsertConfig() {
  const call = mockOnConflictDoUpdate.mock.calls.at(-1);
  if (!call) throw new Error('Expected an upsert');
  return call[0] as {
    target: unknown;
    targetWhere: unknown;
    setWhere: SQL;
    set: Record<string, unknown>;
  };
}

describe('cliSessionsV2.refreshAssociatedPullRequest', () => {
  it('does not expose the removed GitHub status endpoint', async () => {
    const { cliSessionsV2Router } = await import('./cli-sessions-v2-router');
    expect(cliSessionsV2Router._def.procedures).not.toHaveProperty(
      'getAssociatedPullRequestStatus'
    );
    expect(cliSessionsV2Router._def.procedures).toHaveProperty('refreshAssociatedPullRequest');
  });

  it('returns NOT_FOUND before any authorization or GitHub work for a session the caller does not own', async () => {
    mockLimit.mockResolvedValueOnce([]);

    await expect(refresh()).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockEnsureOrganizationAccess).not.toHaveBeenCalled();
    expect(mockGetIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockClaimPrRefresh).not.toHaveBeenCalled();
    expect(mockFetchPullRequestByNumber).not.toHaveBeenCalled();
    expect(mockFetchPullRequestObservations).not.toHaveBeenCalled();
  });

  it('checks organization access before the recent-cache throttle', async () => {
    mockLimit.mockResolvedValueOnce([
      makeCachedRow({
        session: { organization_id: ORGANIZATION_ID, pr_link_verified_at: VERIFIED_AT },
        pr_last_synced_at: new Date().toISOString(),
      }),
    ]);
    mockEnsureOrganizationAccess.mockRejectedValue(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'Organization access denied' })
    );

    await expect(refresh()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ user }),
      ORGANIZATION_ID
    );
    expect(mockGetIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockClaimPrRefresh).not.toHaveBeenCalled();
    expect(mockFetchPullRequestByNumber).not.toHaveBeenCalled();
    expect(mockFetchPullRequestObservations).not.toHaveBeenCalled();
  });

  it('returns the recent cache without either GitHub call when the verified link matches', async () => {
    const cachedObservations = makeObservations({ headSha: CACHED_HEAD_SHA });
    mockLimit.mockResolvedValueOnce([
      makeCachedRow({
        session: { pr_link_verified_at: VERIFIED_AT },
        pr_observations: cachedObservations,
        pr_last_synced_at: new Date().toISOString(),
      }),
    ]);

    const result = await refresh();

    expect(mockClaimPrRefresh).not.toHaveBeenCalled();
    expect(mockFetchPullRequestByNumber).not.toHaveBeenCalled();
    expect(mockFetchPullRequestObservations).not.toHaveBeenCalled();
    expect(result.associatedPr).toEqual({
      url: PR_URL,
      number: 7,
      state: 'open',
      title: 'Cached title',
      headSha: CACHED_HEAD_SHA,
      observations: EXPECTED_OBSERVATION_SUMMARY,
      lastSyncedAt: expect.any(String),
      reviewDecision: 'approved',
      reviewDecisionPending: false,
      platform: 'github',
      baseRef: null,
      stackNumber: null,
      stackPosition: null,
      stackSize: null,
    });
  });

  it('fetches the PR once, then gives that same fetched PR and cached evidence to the observation helper', async () => {
    const existing = makeObservations({ headSha: CACHED_HEAD_SHA });
    const fetched = makeFetched();
    const observations = makeObservations();
    mockLimit.mockResolvedValueOnce([makeCachedRow({ pr_observations: existing })]);
    mockFetchPullRequestByNumber.mockResolvedValue(fetched);
    mockFetchPullRequestObservations.mockResolvedValue({
      observations,
      reviewDecision: 'approved',
      reviewDecisionFetched: true,
    });
    mockReturning.mockResolvedValueOnce([
      {
        pr_url: PR_URL,
        pr_number: 7,
        pr_state: 'open',
        pr_title: 'Fetched title',
        pr_head_sha: FETCHED_HEAD_SHA,
        pr_observations: observations,
        pr_last_synced_at: '2026-01-02T00:00:00.000Z',
        pr_review_decision: 'approved',
        review_decision_pending: false,
      },
    ]);

    const result = await refresh();

    expect(mockClaimPrRefresh).toHaveBeenCalledTimes(1);
    expect(mockDeferPrRefresh).not.toHaveBeenCalled();
    expect(mockFetchPullRequestByNumber).toHaveBeenCalledTimes(1);
    expect(mockFetchPullRequestByNumber).toHaveBeenCalledWith({
      installationId: 12345,
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      appType: 'lite',
      includeCommits: false,
      expectedHeadSha: null,
      signal: expect.any(AbortSignal),
    });
    expect(mockFetchPullRequestObservations).toHaveBeenCalledTimes(1);
    expect(mockFetchPullRequestObservations).toHaveBeenCalledWith({
      installationId: '12345',
      integrationId: 'integration-1',
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      appType: 'lite',
      pullRequest: fetched,
      existing,
      signal: expect.any(AbortSignal),
    });
    expect(mockFetchPullRequestObservations.mock.calls[0][0].pullRequest).toBe(fetched);

    expect(result.associatedPr).toEqual({
      url: PR_URL,
      number: 7,
      state: 'open',
      title: 'Fetched title',
      headSha: FETCHED_HEAD_SHA,
      observations: EXPECTED_OBSERVATION_SUMMARY,
      lastSyncedAt: '2026-01-02T00:00:00.000Z',
      reviewDecision: 'approved',
      reviewDecisionPending: false,
      platform: 'github',
      baseRef: null,
      stackNumber: null,
      stackPosition: null,
      stackSize: null,
    });
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        pr_observations: observations,
        pr_review_decision: 'approved',
        review_decision_pending: false,
      })
    );
  });

  it('claims the refresh budget with the exact user tenant, installation, app, repo, and PR scope', async () => {
    mockLimit.mockResolvedValueOnce([
      makeCachedRow({ session: { pr_link_verified_at: VERIFIED_AT } }),
    ]);
    mockFetchPullRequestByNumber.mockResolvedValue(makeFetched());
    mockFetchPullRequestObservations.mockResolvedValue({
      observations: makeObservations(),
      reviewDecision: 'approved',
      reviewDecisionFetched: true,
    });

    await refresh();

    expect(mockClaimPrRefresh).toHaveBeenCalledWith({
      appType: 'lite',
      installationId: '12345',
      owner: { type: 'user', id: USER_ID },
      repo: 'acme/widgets',
      number: 7,
    });
  });

  it('claims the refresh budget with the exact organization tenant scope', async () => {
    mockLimit.mockResolvedValueOnce([
      makeCachedRow({
        session: { organization_id: ORGANIZATION_ID, pr_link_verified_at: VERIFIED_AT },
      }),
    ]);
    mockClaimPrRefresh.mockResolvedValueOnce({
      allowed: false,
      reason: 'throttled',
      retryAt: RETRY_AT,
    });

    await expect(refresh()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ user }),
      ORGANIZATION_ID
    );
    expect(mockClaimPrRefresh).toHaveBeenCalledWith({
      appType: 'lite',
      installationId: '12345',
      owner: { type: 'org', id: ORGANIZATION_ID },
      repo: 'acme/widgets',
      number: 7,
    });
    expect(mockFetchPullRequestByNumber).not.toHaveBeenCalled();
  });

  it.each([
    ['throttled', 'TOO_MANY_REQUESTS'],
    ['rate_limited', 'TOO_MANY_REQUESTS'],
    ['unavailable', 'SERVICE_UNAVAILABLE'],
  ] as const)('does not call GitHub when the budget denies with %s', async (reason, code) => {
    mockLimit.mockResolvedValueOnce([
      makeCachedRow({ session: { pr_link_verified_at: VERIFIED_AT } }),
    ]);
    mockClaimPrRefresh.mockResolvedValueOnce({
      allowed: false,
      reason,
      retryAt: RETRY_AT,
    });

    await expect(refresh()).rejects.toMatchObject({ code });

    expect(mockFetchPullRequestByNumber).not.toHaveBeenCalled();
    expect(mockFetchPullRequestObservations).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDeferPrRefresh).not.toHaveBeenCalled();
  });

  it('does not claim the budget when the session has no usable PR link', async () => {
    mockLimit.mockResolvedValueOnce([makeRow({ session: { pr_url: null } })]);

    const result = await refresh();

    expect(result.associatedPr).toBeNull();
    expect(mockClaimPrRefresh).not.toHaveBeenCalled();
    expect(mockFetchPullRequestByNumber).not.toHaveBeenCalled();
    expect(mockFetchPullRequestObservations).not.toHaveBeenCalled();
  });

  it('shares one 45 second abort signal across both GitHub legs', async () => {
    const signal = new AbortController().signal;
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    mockLimit.mockResolvedValueOnce([
      makeCachedRow({ session: { pr_link_verified_at: VERIFIED_AT } }),
    ]);
    mockFetchPullRequestByNumber.mockResolvedValue(makeFetched());
    mockFetchPullRequestObservations.mockResolvedValue({
      observations: makeObservations(),
      reviewDecision: 'approved',
      reviewDecisionFetched: true,
    });

    await refresh();

    expect(timeoutSpy).toHaveBeenCalledWith(45_000);
    expect(mockFetchPullRequestByNumber.mock.calls[0][0].signal).toBe(signal);
    expect(mockFetchPullRequestObservations.mock.calls[0][0].signal).toBe(signal);
  });

  it('defers the cooldown when the core fetch is rate limited and writes no cache', async () => {
    const resetAt = new Date('2026-03-01T00:00:30.000Z');
    mockLimit.mockResolvedValueOnce([
      makeCachedRow({ session: { pr_link_verified_at: VERIFIED_AT } }),
    ]);
    mockFetchPullRequestByNumber.mockRejectedValueOnce(new GitHubRateLimitError(resetAt));

    await expect(refresh()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    expect(mockDeferPrRefresh).toHaveBeenCalledWith({
      appType: 'lite',
      installationId: '12345',
      resetAt,
    });
    expect(mockFetchPullRequestObservations).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('normalizes a raw 429 from the core GitHub leg before deferring', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z').getTime();
    jest.useFakeTimers({ now });
    mockLimit.mockResolvedValueOnce([
      makeCachedRow({ session: { pr_link_verified_at: VERIFIED_AT } }),
    ]);
    mockFetchPullRequestByNumber.mockRejectedValueOnce({
      status: 429,
      response: { headers: { 'retry-after': '42' } },
    });

    await expect(refresh()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    expect(mockDeferPrRefresh).toHaveBeenCalledWith({
      appType: 'lite',
      installationId: '12345',
      resetAt: new Date(now + 42_000),
    });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('normalizes a raw retry 403 from the supplemental leg before deferring and writing cache', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z').getTime();
    jest.useFakeTimers({ now });
    mockLimit.mockResolvedValueOnce([
      makeCachedRow({ session: { pr_link_verified_at: VERIFIED_AT } }),
    ]);
    mockFetchPullRequestByNumber.mockResolvedValue(makeFetched());
    mockFetchPullRequestObservations.mockRejectedValueOnce({
      status: 403,
      message: 'You have exceeded a secondary rate limit',
      response: { headers: { 'retry-after': '30' } },
    });

    await expect(refresh()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    expect(mockFetchPullRequestObservations).toHaveBeenCalledTimes(1);
    expect(mockDeferPrRefresh).toHaveBeenCalledWith({
      appType: 'lite',
      installationId: '12345',
      resetAt: new Date(now + 30_000),
    });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('does not release the attempt when the core fetch fails for a non-rate-limit reason', async () => {
    mockLimit.mockResolvedValueOnce([
      makeCachedRow({ session: { pr_link_verified_at: VERIFIED_AT } }),
    ]);
    mockFetchPullRequestByNumber.mockRejectedValueOnce(new Error('core read failed'));

    await expect(refresh()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    expect(mockClaimPrRefresh).toHaveBeenCalledTimes(1);
    expect(mockDeferPrRefresh).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it.each<[string, AssociatedPullRequest | null]>([
    ['a fork head repository', makeFetched({ headRepoFullName: 'fork/widgets' })],
    ['a different base repository', makeFetched({ baseRepoFullName: 'other/widgets' })],
    ['a different head branch', makeFetched({ headRef: 'someone-elses-branch' })],
    ['a lookup that returns no PR', null],
  ])('does not fetch observations for %s', async (_label, fetched) => {
    mockLimit.mockResolvedValueOnce([makeCachedRow()]);
    mockFetchPullRequestByNumber.mockResolvedValue(fetched);

    const result = await refresh();

    expect(result.associatedPr).toBeNull();
    expect(mockFetchPullRequestObservations).not.toHaveBeenCalled();
  });

  it('keeps the existing review decision on a transient observation failure, together with the pending flags', async () => {
    const fetched = makeFetched();
    const observations = makeObservations();
    mockLimit.mockResolvedValueOnce([makeCachedRow()]);
    mockFetchPullRequestByNumber.mockResolvedValue(fetched);
    mockFetchPullRequestObservations.mockResolvedValue({
      observations,
      reviewDecision: null,
      reviewDecisionFetched: false,
    });
    mockReturning.mockResolvedValueOnce([
      {
        pr_url: PR_URL,
        pr_number: 7,
        pr_state: 'open',
        pr_title: fetched.title,
        pr_head_sha: fetched.headSha,
        pr_observations: observations,
        pr_last_synced_at: '2026-01-02T00:00:00.000Z',
        pr_review_decision: 'approved',
        review_decision_pending: false,
      },
    ]);

    const result = await refresh();

    const upsert = lastUpsertConfig();
    expect(upsert.set.pr_review_decision).toBe(github_branch_pull_requests.pr_review_decision);
    expect(upsert.set.review_decision_pending).toBe(
      github_branch_pull_requests.review_decision_pending
    );
    expect(upsert.set.review_decision_fetching_at).toBe(
      github_branch_pull_requests.review_decision_fetching_at
    );
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ pr_review_decision: null, review_decision_pending: true })
    );
    expect(result.associatedPr).toMatchObject({
      reviewDecision: 'approved',
      reviewDecisionPending: false,
      observations: EXPECTED_OBSERVATION_SUMMARY,
    });
  });

  it('overwrites the review decision only when the helper fetched it', async () => {
    mockLimit.mockResolvedValueOnce([makeCachedRow()]);
    mockFetchPullRequestByNumber.mockResolvedValue(makeFetched());
    mockFetchPullRequestObservations.mockResolvedValue({
      observations: makeObservations(),
      reviewDecision: 'changes_requested',
      reviewDecisionFetched: true,
    });
    mockReturning.mockResolvedValueOnce([
      {
        pr_url: PR_URL,
        pr_number: 7,
        pr_state: 'open',
        pr_title: 'Fetched title',
        pr_head_sha: FETCHED_HEAD_SHA,
        pr_observations: makeObservations(),
        pr_last_synced_at: '2026-01-02T00:00:00.000Z',
        pr_review_decision: 'changes_requested',
        review_decision_pending: false,
      },
    ]);

    await refresh();

    const upsert = lastUpsertConfig();
    expect(new PgDialect().sqlToQuery(upsert.set.pr_review_decision as SQL).sql).toBe(
      'excluded.pr_review_decision'
    );
    expect(upsert.set.review_decision_pending).toBe(false);
    expect(upsert.set.review_decision_fetching_at).toBeNull();
  });

  it('compares the upsert to the exact raw PostgreSQL updated_at it selected', async () => {
    mockLimit.mockResolvedValueOnce([makeCachedRow()]);
    mockFetchPullRequestByNumber.mockResolvedValue(makeFetched());
    mockFetchPullRequestObservations.mockResolvedValue({
      observations: makeObservations(),
      reviewDecision: 'approved',
      reviewDecisionFetched: true,
    });

    await refresh();

    const query = new PgDialect().sqlToQuery(lastUpsertConfig().setWhere);
    expect(query.sql).toContain('"updated_at"');
    expect(query.params).toEqual([RAW_CACHE_UPDATED_AT]);
  });

  it('keeps refreshing canonical PR status when supplemental reads throw', async () => {
    mockLimit.mockResolvedValueOnce([makeCachedRow({ pr_observations: makeObservations() })]);
    mockFetchPullRequestByNumber.mockResolvedValue(makeFetched());
    mockFetchPullRequestObservations.mockRejectedValue(new Error('supplemental read failed'));

    const result = await refresh();

    expect(result.associatedPr?.title).toBe('Fetched title');
    expect(result.associatedPr?.observations?.unavailable).toEqual([
      'checks',
      'statuses',
      'reviews',
    ]);
    expect(result.associatedPr?.observations?.checks?.complete).toBe(false);
    expect(lastUpsertConfig().set.pr_review_decision).toBe(
      github_branch_pull_requests.pr_review_decision
    );
    expect(mockClaimPrRefresh).toHaveBeenCalledTimes(1);
    expect(mockDeferPrRefresh).not.toHaveBeenCalled();
  });

  it('uses a false upsert guard when no initial cache row was read', async () => {
    mockLimit.mockResolvedValueOnce([makeRow()]);
    mockFetchPullRequestByNumber.mockResolvedValue(makeFetched());
    mockFetchPullRequestObservations.mockResolvedValue({
      observations: makeObservations(),
      reviewDecision: 'approved',
      reviewDecisionFetched: true,
    });

    await refresh();

    const query = new PgDialect().sqlToQuery(lastUpsertConfig().setWhere);
    expect(query.sql.trim()).toBe('false');
    expect(query.params).toEqual([]);
  });

  it('finds a pre-existing tenant PR cache before refreshing an unverified session link', async () => {
    const existing = makeCachedRow({ pr_observations: makeObservations() });
    mockLimit.mockResolvedValueOnce([makeRow()]).mockResolvedValueOnce([
      {
        ...existing,
        updated_at: RAW_CACHE_UPDATED_AT,
      },
    ]);
    mockFetchPullRequestByNumber.mockResolvedValue(makeFetched());
    mockFetchPullRequestObservations.mockResolvedValue({
      observations: makeObservations(),
      reviewDecision: 'approved',
      reviewDecisionFetched: true,
    });

    await refresh();

    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect(mockLimit.mock.invocationCallOrder[1]).toBeLessThan(
      mockFetchPullRequestByNumber.mock.invocationCallOrder[0]
    );
    expect(mockFetchPullRequestObservations).toHaveBeenCalledWith(
      expect.objectContaining({
        existing: existing.pr_observations,
      })
    );
    expect(new PgDialect().sqlToQuery(lastUpsertConfig().setWhere).params).toEqual([
      RAW_CACHE_UPDATED_AT,
    ]);
  });

  it('reads the winning cache after losing the compare-and-set instead of returning the stale fetch', async () => {
    const winningObservations = makeObservations({
      headSha: WINNING_HEAD_SHA,
      checks: [
        {
          key: 'check:9:webhook',
          id: '9',
          attempt: 1,
          at: null,
          phase: 2,
          failed: true,
          outcome: 'failed',
        },
      ],
      threadsObserved: true,
      threads: [],
    });
    mockLimit.mockResolvedValueOnce([makeCachedRow()]).mockResolvedValueOnce([
      {
        pr_url: PR_URL,
        pr_number: 7,
        pr_state: 'closed',
        pr_title: 'Webhook title',
        pr_head_sha: WINNING_HEAD_SHA,
        pr_observations: winningObservations,
        pr_last_synced_at: '2026-01-03T00:00:00.000Z',
        pr_review_decision: 'changes_requested',
        review_decision_pending: false,
      },
    ]);
    mockFetchPullRequestByNumber.mockResolvedValue(
      makeFetched({ headSha: FETCHED_HEAD_SHA, title: 'Stale fetch', state: 'open' })
    );
    mockFetchPullRequestObservations.mockResolvedValue({
      observations: makeObservations(),
      reviewDecision: 'approved',
      reviewDecisionFetched: true,
    });
    mockReturning.mockResolvedValueOnce([]);

    const result = await refresh();

    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect(result.associatedPr).toEqual({
      url: PR_URL,
      number: 7,
      state: 'closed',
      title: 'Webhook title',
      headSha: WINNING_HEAD_SHA,
      observations: {
        checks: {
          total: 1,
          failed: 1,
          passed: 0,
          pending: 0,
          skipped: 0,
          unknown: 0,
          complete: true,
        },
        unresolvedThreads: 0,
        truncated: false,
        threadsComplete: true,
      },
      lastSyncedAt: '2026-01-03T00:00:00.000Z',
      reviewDecision: 'changes_requested',
      reviewDecisionPending: false,
      platform: 'github',
      baseRef: null,
      stackNumber: null,
      stackPosition: null,
      stackSize: null,
    });
    expect(result.associatedPr?.title).not.toBe('Stale fetch');
    expect(result.associatedPr?.headSha).not.toBe(FETCHED_HEAD_SHA);
  });
});
