const mockWhere = jest.fn(),
  mockConflictClaim = jest.fn();
const mockCandidates = jest.fn(),
  mockUpdate = jest.fn(),
  mockRequest = jest.fn(),
  mockToken = jest.fn(),
  mockBudget = jest.fn(),
  mockDefer = jest.fn(),
  mockAttempts = jest.fn(),
  mockDispositions = jest.fn();
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    query: {
      cloud_agent_pr_maintenance_attempts: { findMany: () => mockAttempts() },
      cloud_agent_pr_feedback_dispositions: { findMany: () => mockDispositions() },
    },
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          mockWhere(condition);
          return { limit: mockCandidates };
        },
      }),
    }),
    update: () => ({ set: (values: unknown) => ({ where: () => mockUpdate(values) }) }),
  },
}));
jest.mock('@octokit/rest', () => ({
  Octokit: class {
    request = mockRequest;
  },
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (...args: unknown[]) => mockToken(...args),
  toGitHubRateLimitError: (error: { status?: number }) =>
    error?.status === 429 ? { resetAt: new Date('2026-11-12T13:00:00Z') } : null,
}));
jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(),
  GitHubRuntimeAuthorizationError: class extends Error {},
}));
jest.mock('@/lib/integrations/platforms/github/pr-refresh-budget', () => ({
  claimPrMaintenanceCall: (...args: unknown[]) => mockBudget(...args),
  deferPrRefresh: (...args: unknown[]) => mockDefer(...args),
  recordPrMaintenanceApiCall: jest.fn(),
  claimPrConflictBatch: (...args: unknown[]) => mockConflictClaim(...args),
}));
jest.mock('./watch-pr-assessment', () => ({
  watchPrRepository: () => ({ owner: 'test', repo: 'repo' }),
}));
import { validateGitHubGraphQl } from '@/tests/helpers/github-graphql-schema';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { CloudAgentPrWatch } from '@kilocode/db/schema';
import { watchPrMaintenancePolicySchema } from '@kilocode/db/cloud-agent-pr-maintenance';
import { emptyWatchPrProjection, watchPrProjectionSchema } from './watch-pr-events';
import { buildWatchPrConflictQuery, processWatchPrConflictBatch } from './watch-pr-conflicts';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  now = '2026-11-12T12:00:00Z';
const policy = watchPrMaintenancePolicySchema.parse({
  version: 2,
  automaticWritesConsent: true,
  historyRewriteConsent: true,
  noHardSpendCapConsent: true,
  model: 'test/model',
  profileId: null,
  environmentId: null,
  categories: { reviews: true, failedChecks: true, conflicts: true },
});
function watch(index: number, retries: 0 | 1 = 0): CloudAgentPrWatch {
  return {
    id: `watch-${index}`,
    integration_id: 'test-integration',
    repo_url: 'https://github.com/test/repo',
    pr_number: index + 1,
    head_ref: 'feature',
    base_ref: 'main',
    head_sha: head,
    base_sha: base,
    status: 'watching',
    generation: 1,
    pending_revision: 0,
    total_attempts: 0,
    policy,
    projection: {
      ...emptyWatchPrProjection(),
      conflict: {
        headSha: head,
        baseSha: base,
        state: 'UNKNOWN',
        checkedAt: null,
        dueAt: now,
        retries,
      },
    },
    updated_at: now,
  } as CloudAgentPrWatch;
}
const scope = { appType: 'standard' as const, installationId: '123' };
function result(state = 'MERGEABLE') {
  return {
    pullRequest: {
      headRefOid: head,
      baseRefOid: base,
      baseRefName: 'main',
      mergeable: state,
      files: {
        nodes: [{ path: 'src/list.ts', changeType: 'MODIFIED' }],
        pageInfo: { hasNextPage: false },
      },
    },
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers().setSystemTime(new Date(now));
  mockBudget.mockResolvedValue({ allowed: true });
  mockConflictClaim.mockResolvedValue({ allowed: true });
  mockToken.mockResolvedValue({ token: 'test-token' });
  mockUpdate.mockResolvedValue(undefined);
  mockAttempts.mockResolvedValue([]);
  mockDispositions.mockResolvedValue([]);
});
afterEach(() => jest.useRealTimers());
describe('installation conflict batch', () => {
  it('excludes live workspace attempts in the actual candidate SQL', async () => {
    mockCandidates.mockResolvedValue([]);
    await processWatchPrConflictBatch(scope);
    const query = new PgDialect().sqlToQuery(mockWhere.mock.calls[0][0]);
    expect(query.sql).toContain('NOT EXISTS');
    expect(query.sql).toContain(
      '"cloud_agent_pr_maintenance_attempts"."worktree_id" = "cloud_agent_pr_watches"."worktree_id"'
    );
    expect(query.params).toEqual(expect.arrayContaining(['creating', 'running', 'needs_input']));
  });
  it('persists a durable due time when another dispatch owns the installation batch', async () => {
    const retryAt = new Date('2026-11-12T12:01:00Z');
    mockCandidates.mockResolvedValue([watch(0)]);
    mockConflictClaim.mockResolvedValue({ allowed: false, reason: 'throttled', retryAt });
    expect(await processWatchPrConflictBatch(scope)).toEqual({
      status: 'deferred',
      reason: 'throttled',
      retryAt,
    });
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockUpdate.mock.calls[0][0].next_run_at).toBe(retryAt.toISOString());
  });
  it('uses one schema-valid query for several PRs and handles each alias separately', async () => {
    const watches = [watch(0), watch(1), watch(2)];
    mockCandidates.mockResolvedValue(watches);
    mockRequest.mockResolvedValue({
      headers: {},
      data: {
        data: {
          rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: '2026-11-12T13:00:00Z' },
          p0: result('CONFLICTING'),
          p1: result(),
          p2: null,
        },
        errors: [{ type: 'NOT_FOUND', path: ['p2'] }],
      },
    });
    expect(await processWatchPrConflictBatch(scope)).toEqual({ status: 'completed', checked: 3 });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(validateGitHubGraphQl(mockRequest.mock.calls[0][1].query)).toEqual([]);
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({
      pending_revision: 1,
      projection: {
        pending: [{ key: 'conflict', reason: 'conflict' }],
        conflict: { state: 'CONFLICTING' },
      },
    });
    expect(mockUpdate.mock.calls[1][0]).toMatchObject({
      pending_revision: 0,
      projection: { pending: [], conflict: { state: 'MERGEABLE', dueAt: null } },
    });
    expect(mockUpdate.mock.calls[2][0]).toMatchObject({
      projection: {
        pending: [],
        conflict: { state: 'UNKNOWN', retries: 1, dueAt: '2026-11-12T12:00:30.000Z' },
      },
    });
  });
  it('bounds queries to twenty-five aliases', () => {
    expect(() =>
      buildWatchPrConflictQuery(Array.from({ length: 26 }, (_, index) => watch(index)))
    ).toThrow('size');
    expect(
      validateGitHubGraphQl(
        buildWatchPrConflictQuery(Array.from({ length: 25 }, (_, index) => watch(index)))
      )
    ).toEqual([]);
  });
  it('uses only simple mergeability fields when the head file list is already cached', () => {
    const current = watch(0);
    current.projection = {
      ...emptyWatchPrProjection(),
      files: { headSha: head, paths: ['src/list.ts'], complete: true },
    };
    const query = buildWatchPrConflictQuery([current]);
    expect(query).not.toContain('files(');
    expect(validateGitHubGraphQl(query)).toEqual([]);
  });
  it('does not poll after the one UNKNOWN retry and schedules local attention', async () => {
    mockCandidates.mockResolvedValue([watch(0, 1)]);
    mockRequest.mockResolvedValue({ headers: {}, data: { data: { p0: result('UNKNOWN') } } });
    await processWatchPrConflictBatch(scope);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        projection: expect.objectContaining({
          needsAttention: true,
          conflict: expect.objectContaining({ state: 'UNKNOWN', dueAt: null }),
        }),
        next_run_at: '2026-11-12T12:00:30.000Z',
      })
    );
    mockCandidates.mockResolvedValue([{ ...watch(0, 1), ...mockUpdate.mock.calls[0][0] }]);
    jest.setSystemTime(new Date('2026-11-12T12:00:31Z'));
    await processWatchPrConflictBatch(scope);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
  it('waits fifteen minutes between base-triggered reads', async () => {
    const current = watch(0);
    current.projection = {
      ...emptyWatchPrProjection(),
      conflict: {
        headSha: head,
        baseSha: base,
        state: 'UNKNOWN',
        checkedAt: '2026-11-12T11:59:00Z',
        dueAt: now,
        retries: 0,
      },
    };
    mockCandidates.mockResolvedValue([current]);
    await processWatchPrConflictBatch(scope);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockUpdate.mock.calls[0][0].next_run_at).toBe('2026-11-12T12:14:00.000Z');
  });
  function withConversationFeedback(current: CloudAgentPrWatch): CloudAgentPrWatch {
    return {
      ...current,
      projection: {
        ...watchPrProjectionSchema.parse(current.projection),
        pending: [{ key: 'issue_comment:9', reason: 'actionable_review' }],
        evidence: [
          {
            kind: 'feedback',
            key: 'issue_comment:9',
            sha: head,
            updatedAt: now,
            state: 'commented',
            actorLogin: 'reviewer',
            trusted: true,
            body: 'Rename the helper',
            sourceId: '9',
            source: 'conversation_comment',
            contentFingerprint: 'feedback-9',
          },
        ],
      },
    };
  }
  it('does not call GitHub when a repair will start and the agent checks conflicts with Git', async () => {
    mockCandidates.mockResolvedValue([withConversationFeedback(watch(0))]);
    await processWatchPrConflictBatch(scope);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockUpdate.mock.calls[0][0].projection.conflict.dueAt).toBeNull();
  });
  it('still checks conflicts when pending feedback was already handled', async () => {
    mockCandidates.mockResolvedValue([withConversationFeedback(watch(0))]);
    mockDispositions.mockResolvedValue([
      {
        problem_key: 'issue_comment:9',
        content_fingerprint: 'feedback-9',
        disposition: 'disagreed',
      },
    ]);
    mockRequest.mockResolvedValue({
      headers: {},
      data: { data: { p0: result('CONFLICTING') } },
    });
    expect(await processWatchPrConflictBatch(scope)).toEqual({ status: 'completed', checked: 1 });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].projection.pending).toContainEqual({
      key: 'conflict',
      reason: 'conflict',
    });
  });
  it('still checks conflicts when the lifetime attempt limit prevents a repair', async () => {
    mockCandidates.mockResolvedValue([
      { ...withConversationFeedback(watch(0)), total_attempts: policy.maxTotalAttempts },
    ]);
    mockRequest.mockResolvedValue({ headers: {}, data: { data: { p0: result() } } });
    await processWatchPrConflictBatch(scope);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
  it('persists installation cooldown instead of immediately retrying a GraphQL 200 rate-limit error', async () => {
    mockCandidates.mockResolvedValue([watch(0), watch(1)]);
    mockRequest.mockResolvedValue({ headers: {}, data: { errors: [{ type: 'RATE_LIMITED' }] } });
    expect(await processWatchPrConflictBatch(scope)).toEqual({
      status: 'deferred',
      reason: 'rate_limited',
      retryAt: new Date('2026-11-12T13:00:00Z'),
    });
    expect(mockDefer).toHaveBeenCalledWith({ ...scope, resetAt: new Date('2026-11-12T13:00:00Z') });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
