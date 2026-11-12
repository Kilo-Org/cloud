const mockGet = jest.fn(),
  mockToken = jest.fn(),
  mockRefresh = jest.fn(),
  mockClaim = jest.fn(),
  mockMaintenance = jest.fn(),
  mockDefer = jest.fn(),
  mockRate = jest.fn();
jest.mock('@octokit/rest', () => ({
  Octokit: class {
    pulls = { get: mockGet };
  },
}));
jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  GitHubRuntimeAuthorizationError: class extends Error {},
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (...args: unknown[]) => mockToken(...args),
  toGitHubRateLimitError: (value: unknown) => mockRate(value),
}));
jest.mock('@/lib/integrations/platforms/github/pr-status', () => ({
  fetchPullRequestObservations: (...args: unknown[]) => mockRefresh(...args),
}));
jest.mock('@/lib/integrations/platforms/github/pr-refresh-budget', () => ({
  claimPrRefresh: (...args: unknown[]) => mockClaim(...args),
  claimPrMaintenanceCall: (...args: unknown[]) => mockMaintenance(...args),
  deferPrRefresh: (...args: unknown[]) => mockDefer(...args),
  recordPrMaintenanceApiCall: jest.fn(),
  PrMaintenanceDeferredError: class extends Error {},
}));
import type { CloudAgentPrWatch } from '@kilocode/db/schema';
import { watchPrMaintenancePolicySchema } from '@kilocode/db/cloud-agent-pr-maintenance';
import { createEmptyPrObservations } from '@/lib/integrations/platforms/github/pr-observations';
import { prMaintenanceFeedbackCommentSchema } from '@/lib/integrations/platforms/github/pr-maintenance-feedback';
import { assessWatchPr } from './watch-pr-assessment';
import { emptyWatchPrProjection } from './watch-pr-events';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  old = 'c'.repeat(40),
  at = '2026-11-12T12:00:00Z';
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
const watch = {
  id: 'watch-test',
  kilo_user_id: 'oauth/test',
  organization_id: null,
  integration_id: 'integration-test',
  installation_id: '123',
  github_app_type: 'standard',
  repository_id: '456',
  repo_url: 'https://github.com/test/repo',
  pr_number: 7,
  head_ref: 'feature',
  base_ref: 'main',
  head_sha: head,
  base_sha: base,
  status: 'watching',
  generation: 1,
  pending_revision: 0,
  policy,
  projection: emptyWatchPrProjection(),
  lifecycle_reason: null,
} as CloudAgentPrWatch;
const feedback = {
  fullDatabaseId: '9',
  body: 'Handle the empty list.',
  authorAssociation: 'MEMBER',
  author: { login: 'reviewer', __typename: 'User', databaseId: '8' },
  updatedAt: at,
  url: 'https://github.com/test/repo/pull/7#discussion_r9',
  commit: { oid: old },
  source: 'review_comment',
  threadId: 'thread-1',
  resolved: false,
};

beforeEach(() => {
  jest.resetAllMocks();
  mockToken.mockResolvedValue({ token: 'test-token' });
  mockClaim.mockResolvedValue({ allowed: true });
  mockMaintenance.mockResolvedValue({ allowed: true });
  mockRate.mockReturnValue(null);
  mockGet.mockResolvedValue({
    headers: {},
    data: {
      number: 7,
      url: 'https://api.github.com/repos/test/repo/pulls/7',
      html_url: 'https://github.com/test/repo/pull/7',
      state: 'open',
      merged: false,
      draft: false,
      title: 'Add bounded lists',
      body: 'Handle list input only.',
      updated_at: at,
      head: { sha: head, ref: 'feature', repo: { id: 456 } },
      base: { sha: base, ref: 'main', repo: { id: 456 } },
      mergeable: true,
      mergeable_state: 'clean',
    },
  });
  mockRefresh.mockResolvedValue({
    observations: {
      ...createEmptyPrObservations(),
      headSha: head,
      checksObserved: true,
      checksComplete: true,
      checks: [
        {
          key: 'check:1:tests',
          id: '10',
          attempt: 1,
          at,
          phase: 2,
          failed: true,
          outcome: 'failed',
        },
        {
          key: 'check:1:pending',
          id: '11',
          attempt: 1,
          at,
          phase: 1,
          failed: false,
          outcome: 'pending',
        },
        {
          key: 'check:1:unknown',
          id: '12',
          attempt: 1,
          at,
          phase: 2,
          failed: false,
          outcome: 'unknown',
        },
      ],
    },
    maintenance: {
      feedback: [feedback],
      files: ['src/list.ts'],
      filesComplete: true,
      complete: true,
    },
    maintenanceCheckDetails: [
      {
        id: '10',
        name: 'tests',
        detailsUrl: 'https://github.com/test/repo/actions/runs/20/job/30',
      },
    ],
  });
});
describe('initial shared PR assessment', () => {
  it('uses the existing per-PR throttle and refresh, and includes old unresolved feedback and terminal failures', async () => {
    const assessment = await assessWatchPr(watch, 'recheck');
    expect(mockClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'test/repo',
        number: 7,
        owner: { type: 'user', id: 'oauth/test' },
      })
    );
    expect(mockRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        maintenanceReason: 'recheck',
        integrationId: 'integration-test',
        number: 7,
      })
    );
    expect(assessment.status).toBe('assessed');
    if (assessment.status !== 'assessed') throw new Error('Expected assessment');
    expect(assessment.problems).toMatchObject([
      { kind: 'review', commitSha: old, threadId: 'thread-1' },
      {
        kind: 'failed_check',
        checkId: '10',
        detailsUrl: 'https://github.com/test/repo/actions/runs/20/job/30',
      },
    ]);
    expect(assessment.problems).toHaveLength(2);
    expect(assessment.pullRequest).toMatchObject({ title: 'Add bounded lists' });
    expect(assessment.state.projection).toMatchObject({
      purpose: { title: 'Add bounded lists', body: 'Handle list input only.' },
    });
    expect(assessment.observations.checks.map(check => check.outcome)).toEqual([
      'failed',
      'pending',
      'unknown',
    ]);
    expect(assessment.state.pending_revision).toBe(1);
  });
  it('trusts Kilo reviewer feedback read from GraphQL, whose bot logins omit the [bot] suffix', async () => {
    const refreshed = await mockRefresh();
    const botComment = prMaintenanceFeedbackCommentSchema.parse({
      fullDatabaseId: '40',
      body: 'Guard the null list before mapping.',
      authorAssociation: 'NONE',
      author: { login: 'kiloconnect', __typename: 'Bot', databaseId: 5 },
      updatedAt: at,
      url: 'https://github.com/test/repo/pull/7#discussion_r40',
      commit: { oid: head },
    });
    mockRefresh.mockResolvedValue({
      ...refreshed,
      observations: { ...refreshed.observations, checks: [] },
      maintenance: {
        ...refreshed.maintenance,
        feedback: [
          { ...botComment, source: 'review_comment', threadId: 'thread-2', resolved: false },
        ],
      },
    });
    const assessment = await assessWatchPr(watch, 'recheck');
    if (assessment.status !== 'assessed') throw new Error('Expected assessment');
    expect(assessment.problems).toMatchObject([
      { kind: 'review', sourceId: '40', threadId: 'thread-2', authorLogin: 'kiloconnect[bot]' },
    ]);
    expect(assessment.problems).toHaveLength(1);
    expect(assessment.state.projection).toMatchObject({
      evidence: [{ key: 'comment:40', trusted: true, actorLogin: 'kiloconnect[bot]' }],
    });
  });
  it('makes no GitHub request while the shared throttle or installation cooldown applies', async () => {
    const retryAt = new Date('2026-11-12T13:00:00Z');
    mockClaim.mockResolvedValue({ allowed: false, reason: 'throttled', retryAt });
    expect(await assessWatchPr(watch)).toEqual({
      status: 'deferred',
      reason: 'throttled',
      retryAt,
    });
    expect(mockGet).not.toHaveBeenCalled();
    mockMaintenance.mockResolvedValue({ allowed: false, reason: 'low_budget', retryAt });
    expect(await assessWatchPr(watch)).toEqual({
      status: 'deferred',
      reason: 'low_budget',
      retryAt,
    });
    expect(mockToken).not.toHaveBeenCalled();
  });
  it('preserves independent same-name checks from the shared raw check refresh', async () => {
    const refreshed = await mockRefresh();
    mockRefresh.mockResolvedValue({
      ...refreshed,
      maintenance: { ...refreshed.maintenance, feedback: [] },
      maintenanceCheckRuns: [
        {
          id: 10,
          app: { id: 1 },
          check_suite: { id: 20 },
          name: 'tests',
          head_sha: head,
          status: 'completed',
          conclusion: 'failure',
          started_at: at,
          completed_at: at,
        },
        {
          id: 11,
          app: { id: 1 },
          check_suite: { id: 21 },
          name: 'tests',
          head_sha: head,
          status: 'completed',
          conclusion: 'success',
          started_at: at,
          completed_at: at,
        },
      ],
    });
    const assessment = await assessWatchPr(watch);
    if (assessment.status !== 'assessed') throw new Error('Expected assessment');
    expect(assessment.problems).toMatchObject([{ kind: 'failed_check', checkId: '10' }]);
    expect(assessment.problems).toHaveLength(1);
  });
  it('rejects a fork or changed head branch instead of repairing an unrelated branch', async () => {
    const response = await mockGet();
    mockGet.mockResolvedValue({
      ...response,
      data: { ...response.data, head: { sha: head, ref: 'other', repo: { id: 999 } } },
    });
    await expect(assessWatchPr(watch)).rejects.toThrow('no longer matches');
    expect(mockRefresh).not.toHaveBeenCalled();
  });
  it('defers the whole installation after a rate limit instead of accepting partial assessment', async () => {
    const resetAt = new Date('2026-11-12T13:00:00Z');
    mockRefresh.mockRejectedValue(new Error('rate limit'));
    mockRate.mockReturnValue({ resetAt });
    expect(await assessWatchPr(watch)).toEqual({
      status: 'deferred',
      reason: 'rate_limited',
      retryAt: resetAt,
    });
    expect(mockDefer).toHaveBeenCalledWith({ installationId: '123', appType: 'standard', resetAt });
  });
  it.each([401, 403, 404])(
    'surfaces confirmed HTTP%s access failure without a transient retry loop',
    async status => {
      mockGet.mockRejectedValue({ status });
      await expect(assessWatchPr(watch)).rejects.toMatchObject({
        code: status === 404 ? 'PRECONDITION_FAILED' : 'FORBIDDEN',
      });
    }
  );
});
