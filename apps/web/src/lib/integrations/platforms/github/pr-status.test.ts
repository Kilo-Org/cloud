const mockGenerateToken = jest.fn();
const mockOctokitConstructor = jest.fn();
const mockPullsGet = jest.fn();
const mockListForRef = jest.fn();
const mockGetCombinedStatusForRef = jest.fn();
const mockGraphQlRequest = jest.fn();

jest.mock('./adapter', () => {
  class MockGitHubRateLimitError extends Error {
    public readonly resetAt: Date;
    constructor(resetAt: Date) {
      super(`GitHub rate limited until ${resetAt.toISOString()}`);
      this.name = 'GitHubRateLimitError';
      this.resetAt = resetAt;
    }
  }

  function toGitHubRateLimitError(error: unknown): MockGitHubRateLimitError | null {
    if (error instanceof MockGitHubRateLimitError) return error;
    if (typeof error !== 'object' || error === null) return null;
    const record = error as {
      status?: unknown;
      message?: unknown;
      response?: { headers?: Record<string, unknown> };
    };
    const headers = record.response?.headers ?? {};
    const header = (name: string) => {
      const value = headers[name] ?? headers[name.toLowerCase()];
      return typeof value === 'string' ? value : undefined;
    };
    const status = record.status;
    const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
    const rateLimited =
      status === 429 ||
      header('x-ratelimit-remaining') === '0' ||
      (status === 403 &&
        (header('retry-after') !== undefined ||
          message.includes('rate limit') ||
          message.includes('abuse')));
    if (!rateLimited) return null;
    const now = Date.now();
    const deadlines: number[] = [];
    const retryAfter = header('retry-after')?.trim();
    if (retryAfter) {
      if (/^\d+$/.test(retryAfter)) deadlines.push(now + Number(retryAfter) * 1000);
      else {
        const parsed = Date.parse(retryAfter);
        if (Number.isFinite(parsed)) deadlines.push(parsed);
      }
    }
    if (header('x-ratelimit-remaining') === '0') {
      const reset = Number(header('x-ratelimit-reset'));
      if (Number.isFinite(reset) && reset > 0) deadlines.push(reset * 1000);
    }
    const deadline = deadlines.length > 0 ? Math.max(...deadlines) : now + 60_000;
    return new MockGitHubRateLimitError(new Date(deadline));
  }

  return {
    generateGitHubInstallationToken: (...args: unknown[]) => mockGenerateToken(...args),
    GitHubRateLimitError: MockGitHubRateLimitError,
    toGitHubRateLimitError,
  };
});

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation((options: unknown) => {
    mockOctokitConstructor(options);
    return {
      pulls: { get: mockPullsGet },
      checks: { listForRef: mockListForRef },
      repos: { getCombinedStatusForRef: mockGetCombinedStatusForRef },
      request: mockGraphQlRequest,
    };
  }),
}));

import { fetchPullRequestObservations, type FetchPullRequestObservationsInput } from './pr-status';
import {
  createEmptyPrObservations,
  getPrObservationSummary,
  normalizePrObservationEvent,
  reducePrObservation,
  type PrObservations,
} from './pr-observations';

const HEAD_SHA = '1111111111111111111111111111111111111111';
const BASE_SHA = '2222222222222222222222222222222222222222';
const OLD_SHA = '3333333333333333333333333333333333333333';
const AT = '2026-10-21T12:00:00Z';
const LATER = '2026-10-21T12:01:00Z';

const input: FetchPullRequestObservationsInput = {
  installationId: '123',
  integrationId: 'integration-1',
  appType: 'standard',
  owner: 'acme',
  repo: 'widgets',
  number: 7,
  pullRequest: {
    number: 7,
    htmlUrl: 'https://github.com/acme/widgets/pull/7',
    state: 'open',
    title: 'Add feature',
    headSha: HEAD_SHA,
    updatedAt: AT,
    baseSha: BASE_SHA,
    baseRef: 'main',
    mergeable: true,
    mergeableState: 'clean',
  },
  existing: null,
};

type CheckRunOverrides = {
  id?: number;
  appId?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  runAttempt?: number;
};

function checkRun(overrides: CheckRunOverrides = {}) {
  return {
    id: overrides.id ?? 1,
    app: { id: overrides.appId ?? 1 },
    name: overrides.name ?? `run-${overrides.id ?? 1}`,
    head_sha: HEAD_SHA,
    run_attempt: overrides.runAttempt ?? 1,
    status: overrides.status ?? 'completed',
    conclusion:
      overrides.conclusion === undefined
        ? overrides.status
          ? null
          : 'success'
        : overrides.conclusion,
    started_at: AT,
    completed_at: LATER,
  };
}

function combinedStatusPage(items: unknown[], link?: string) {
  return { data: { statuses: items }, headers: link ? { link } : {} };
}

function checkRunPage(items: unknown[], link?: string) {
  return { data: { check_runs: items }, headers: link ? { link } : {} };
}

function threadNode(id: string, isResolved: boolean, fullDatabaseId: string | number | null) {
  return { id, isResolved, comments: { nodes: [{ fullDatabaseId }] } };
}

function graphQlPage(
  options: {
    reviewDecision?: string | null;
    nodes?: Array<ReturnType<typeof threadNode>>;
    hasNextPage?: boolean;
    endCursor?: string | null;
  } = {}
) {
  return {
    reviewDecision: options.reviewDecision ?? null,
    reviewThreads: {
      nodes: options.nodes ?? [],
      pageInfo: {
        hasNextPage: options.hasNextPage ?? false,
        endCursor: options.endCursor ?? null,
      },
    },
  };
}

function graphQlResponse(page: ReturnType<typeof graphQlPage>) {
  return { data: { data: { repository: { pullRequest: page } } } };
}

function updatedAt(day: number) {
  return `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;
}

function existingWith(overrides: Partial<PrObservations>): unknown {
  return { ...createEmptyPrObservations(), headSha: HEAD_SHA, ...overrides };
}

beforeEach(() => {
  mockGenerateToken.mockReset().mockResolvedValue({
    token: 'installation-token',
    expires_at: null,
  });
  mockOctokitConstructor.mockReset();
  mockPullsGet.mockReset();
  mockListForRef.mockReset().mockResolvedValue(checkRunPage([]));
  mockGetCombinedStatusForRef.mockReset().mockResolvedValue(combinedStatusPage([]));
  mockGraphQlRequest.mockReset().mockResolvedValue(graphQlResponse(graphQlPage()));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchPullRequestObservations', () => {
  it('generates the agent installation token with the exact app and integration association', async () => {
    await fetchPullRequestObservations({ ...input, appType: 'lite' });

    expect(mockGenerateToken).toHaveBeenCalledWith(
      '123',
      'lite',
      'integration-1',
      'agent',
      expect.any(AbortSignal)
    );
    expect(mockOctokitConstructor).toHaveBeenCalledWith({
      auth: 'installation-token',
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it('never reads the pull request itself or retries mergeability', async () => {
    await fetchPullRequestObservations(input);

    expect(mockPullsGet).not.toHaveBeenCalled();
  });

  it('hydrates keyed check and thread observations with review decision and mergeability', async () => {
    mockListForRef.mockResolvedValue(
      checkRunPage([
        checkRun({ id: 1, name: 'build', conclusion: 'success' }),
        checkRun({ id: 2, name: 'test', conclusion: 'failure' }),
        checkRun({ id: 3, name: 'e2e', status: 'in_progress', conclusion: null }),
        checkRun({ id: 4, name: 'docs', conclusion: 'neutral' }),
      ])
    );
    mockGetCombinedStatusForRef.mockResolvedValue(
      combinedStatusPage([
        { id: 10, context: 'deploy', state: 'success', updated_at: updatedAt(1) },
        { id: 11, context: 'lint', state: 'pending', updated_at: updatedAt(1) },
        { id: 12, context: 'scan', state: 'failure', updated_at: updatedAt(1) },
      ])
    );
    mockGraphQlRequest.mockResolvedValue(
      graphQlResponse(
        graphQlPage({
          reviewDecision: 'CHANGES_REQUESTED',
          nodes: [
            threadNode('PRRT_resolved', true, '9007199254740993'),
            threadNode('PRRT_unresolved', false, '9007199254740994'),
          ],
        })
      )
    );

    const result = await fetchPullRequestObservations(input);

    expect(result.reviewDecision).toBe('changes_requested');
    expect(result.reviewDecisionFetched).toBe(true);
    expect(result.observations).toMatchObject({
      headSha: HEAD_SHA,
      checksObserved: true,
      checksComplete: true,
      checksTruncated: false,
      threadsObserved: true,
      threadsComplete: true,
      threadsTruncated: false,
      unavailable: [],
    });
    expect(result.observations.checks).toHaveLength(7);
    expect(result.observations.checks.map(entry => entry.outcome)).toEqual([
      'passed',
      'failed',
      'pending',
      'skipped',
      'passed',
      'pending',
      'failed',
    ]);
    expect(result.observations.threads).toEqual([
      { rootId: '9007199254740993', threadId: 'PRRT_resolved', state: 'resolved' },
      { rootId: '9007199254740994', threadId: 'PRRT_unresolved', state: 'unresolved' },
    ]);
    expect(result.observations.threads).toHaveLength(2);
    expect(result.observations.mergeability).toMatchObject({
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      baseRef: 'main',
      mergeable: true,
      state: 'clean',
    });
    expect(getPrObservationSummary(result.observations, HEAD_SHA)).toMatchObject({
      checks: {
        total: 7,
        failed: 2,
        passed: 2,
        pending: 2,
        skipped: 1,
        unknown: 0,
        complete: true,
      },
      unresolvedThreads: 1,
      threadsComplete: true,
      truncated: false,
    });

    for (const call of mockListForRef.mock.calls) {
      expect(call[0]).toMatchObject({ ref: HEAD_SHA, filter: 'latest', per_page: 100 });
    }
    for (const call of mockGetCombinedStatusForRef.mock.calls) {
      expect(call[0]).toMatchObject({ ref: HEAD_SHA, per_page: 100 });
    }
    const [method, request] = mockGraphQlRequest.mock.calls[0] as [
      string,
      { query: string; variables: Record<string, unknown> },
    ];
    expect(method).toBe('POST /graphql');
    expect(request.query).toContain('isResolved');
    expect(request.query).toContain('comments(first: 1)');
    expect(request.query).toContain('fullDatabaseId');
    expect(request.query).not.toContain('databaseId');
    expect(request.variables).toMatchObject({ owner: 'acme', name: 'widgets', number: 7 });
  });

  it('summarizes a successful empty inventory as observed and complete', async () => {
    mockGraphQlRequest.mockResolvedValue(
      graphQlResponse(graphQlPage({ reviewDecision: 'APPROVED' }))
    );

    const result = await fetchPullRequestObservations(input);

    expect(result.reviewDecision).toBe('approved');
    expect(result.reviewDecisionFetched).toBe(true);
    expect(result.observations).toMatchObject({
      checksObserved: true,
      checksComplete: true,
      threadsObserved: true,
      threadsComplete: true,
      unavailable: [],
    });
    expect(getPrObservationSummary(result.observations, HEAD_SHA)).toMatchObject({
      checks: {
        total: 0,
        failed: 0,
        passed: 0,
        pending: 0,
        skipped: 0,
        unknown: 0,
        complete: true,
      },
      unresolvedThreads: 0,
      threadsComplete: true,
      truncated: false,
    });
  });

  it('keeps a successful null review decision fetched so the router can replace it', async () => {
    const result = await fetchPullRequestObservations(input);

    expect(result.reviewDecision).toBeNull();
    expect(result.reviewDecisionFetched).toBe(true);
  });

  it('treats GraphQL errors as an unavailable review leg and preserves prior threads', async () => {
    const existing = existingWith({
      threads: [
        { rootId: '200', threadId: 'PRRT_200', state: 'resolved' },
        { rootId: '201', threadId: 'PRRT_201', state: 'unresolved' },
      ],
      threadsObserved: true,
      threadsComplete: true,
    });
    mockGraphQlRequest.mockResolvedValue({
      data: {
        data: null,
        errors: [{ message: 'Resource not accessible by integration' }],
      },
    });

    const result = await fetchPullRequestObservations({ ...input, existing });

    expect(result.reviewDecision).toBeNull();
    expect(result.reviewDecisionFetched).toBe(false);
    expect(result.observations.unavailable).toEqual(['reviews']);
    expect(result.observations.threads).toEqual([
      { rootId: '200', threadId: 'PRRT_200', state: 'resolved' },
      { rootId: '201', threadId: 'PRRT_201', state: 'unresolved' },
    ]);
    expect(result.observations).toMatchObject({
      threadsObserved: true,
      threadsComplete: true,
      checksObserved: true,
      checksComplete: true,
    });
    expect(getPrObservationSummary(result.observations, HEAD_SHA)).toMatchObject({
      unresolvedThreads: 1,
      threadsComplete: false,
      truncated: true,
      unavailable: ['reviews'],
    });
  });

  it('treats a review payload without thread nodes or a cursor as unavailable', async () => {
    mockGraphQlRequest.mockResolvedValue({
      data: {
        data: {
          repository: {
            pullRequest: {
              reviewDecision: 'APPROVED',
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    });

    const missingNodes = await fetchPullRequestObservations(input);
    expect(missingNodes.observations.unavailable).toEqual(['reviews']);
    expect(missingNodes.reviewDecisionFetched).toBe(false);

    mockGraphQlRequest.mockResolvedValue(
      graphQlResponse(graphQlPage({ hasNextPage: true, endCursor: null }))
    );
    const missingCursor = await fetchPullRequestObservations(input);
    expect(missingCursor.observations.unavailable).toEqual(['reviews']);
  });

  it('preserves the failed check-source inventory while replacing a successful status source', async () => {
    const existing = existingWith({
      checks: [
        {
          key: 'check:1:stale',
          id: '5',
          attempt: 1,
          at: AT,
          phase: 2,
          failed: false,
          outcome: 'passed',
        },
        {
          key: 'status:deploy',
          id: '9',
          attempt: 1,
          at: AT,
          phase: 2,
          failed: false,
          outcome: 'passed',
        },
      ],
      checksTruncated: true,
      checksObserved: true,
      checksComplete: true,
    });
    mockListForRef.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    mockGetCombinedStatusForRef.mockResolvedValue(
      combinedStatusPage([
        { id: 10, context: 'deploy', state: 'success', updated_at: updatedAt(2) },
        { id: 9, context: 'deploy', state: 'failure', updated_at: updatedAt(1) },
      ])
    );

    const result = await fetchPullRequestObservations({ ...input, existing });

    expect(result.observations.unavailable).toEqual(['checks']);
    expect(result.observations).toMatchObject({
      checksObserved: false,
      checksComplete: false,
      checksTruncated: true,
    });
    expect(result.observations.checks).toEqual([
      {
        key: 'check:1:stale',
        id: '5',
        attempt: 1,
        at: AT,
        phase: 2,
        failed: false,
        outcome: 'passed',
      },
      {
        key: 'status:deploy',
        id: '10',
        attempt: 1,
        at: updatedAt(2),
        phase: 2,
        failed: false,
        outcome: 'passed',
      },
    ]);
    expect(getPrObservationSummary(result.observations, HEAD_SHA)).toMatchObject({
      checks: { total: 2, failed: 0, passed: 2, complete: false },
      truncated: true,
      unavailable: ['checks'],
    });
  });

  it('preserves the failed status-source inventory while replacing a successful check source', async () => {
    const existing = existingWith({
      checks: [
        {
          key: 'check:1:stale',
          id: '5',
          attempt: 1,
          at: AT,
          phase: 2,
          failed: false,
          outcome: 'passed',
        },
        {
          key: 'status:deploy',
          id: '9',
          attempt: 1,
          at: AT,
          phase: 2,
          failed: false,
          outcome: 'passed',
        },
      ],
    });
    mockListForRef.mockResolvedValue(
      checkRunPage([checkRun({ id: 10, name: 'fresh', conclusion: 'failure' })])
    );
    mockGetCombinedStatusForRef.mockRejectedValue(new Error('Resource not accessible'));

    const result = await fetchPullRequestObservations({ ...input, existing });

    expect(result.observations.unavailable).toEqual(['statuses']);
    expect(result.observations.checks.map(entry => entry.key)).toEqual([
      'status:deploy',
      'check:1:fresh',
    ]);
    expect(result.observations.checks.find(entry => entry.key === 'check:1:fresh')).toMatchObject({
      id: '10',
      outcome: 'failed',
    });
  });

  it('clears previous-head checks, completion flags, and mergeability', async () => {
    const existing = existingWith({
      headSha: OLD_SHA,
      checks: [
        {
          key: 'check:1:old',
          id: '1',
          attempt: 1,
          at: AT,
          phase: 2,
          failed: true,
          outcome: 'failed',
        },
      ],
      checksObserved: true,
      checksComplete: true,
      mergeability: {
        headSha: OLD_SHA,
        baseSha: BASE_SHA,
        baseRef: 'main',
        mergeable: true,
        state: 'clean',
        observedAt: AT,
      },
    });
    const noMetadata = {
      ...input,
      existing,
      pullRequest: {
        number: input.pullRequest.number,
        htmlUrl: input.pullRequest.htmlUrl,
        state: input.pullRequest.state,
        title: input.pullRequest.title,
        headSha: HEAD_SHA,
        updatedAt: input.pullRequest.updatedAt,
      },
    };

    const result = await fetchPullRequestObservations(noMetadata);

    expect(result.observations.checks).toEqual([]);
    expect(result.observations.checksObserved).toBe(true);
    expect(result.observations.checksComplete).toBe(true);
    expect(result.observations.mergeability).toBeUndefined();
    expect(getPrObservationSummary(result.observations, HEAD_SHA)?.checks).toMatchObject({
      total: 0,
      complete: true,
    });
  });

  it('seeds mergeability only from valid pull request metadata', async () => {
    const valid = await fetchPullRequestObservations(input);
    expect(valid.observations.mergeability).toMatchObject({
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      baseRef: 'main',
      mergeable: true,
      state: 'clean',
    });

    const invalid = await fetchPullRequestObservations({
      ...input,
      pullRequest: { ...input.pullRequest, baseSha: 'not-a-sha' },
    });
    expect(invalid.observations.mergeability).toBeUndefined();
  });

  it('updates hydrated keyed inventory from a webhook rerun without duplicating it', async () => {
    mockListForRef.mockResolvedValue(
      checkRunPage([checkRun({ id: 5, name: 'build', conclusion: 'success' })])
    );

    const fetched = await fetchPullRequestObservations(input);
    const rerun = normalizePrObservationEvent('check_run', {
      installation: { id: '123' },
      repository: { id: '99', full_name: 'acme/widgets' },
      check_run: {
        id: 6,
        app: { id: 1 },
        name: 'build',
        head_sha: HEAD_SHA,
        run_attempt: 1,
        status: 'completed',
        conclusion: 'failure',
        started_at: AT,
        completed_at: LATER,
      },
    });
    if (!rerun) throw new Error('Expected a normalized rerun');

    const updated = reducePrObservation(fetched.observations, HEAD_SHA, rerun);
    expect(updated?.checks).toHaveLength(1);
    expect(updated?.checks[0]).toMatchObject({ id: '6', outcome: 'failed' });
    expect(reducePrObservation(updated, HEAD_SHA, rerun)).toEqual(updated);
  });

  it('skips malformed or wrong-head check runs instead of forging identities', async () => {
    mockListForRef.mockResolvedValue(
      checkRunPage([
        {
          id: 1,
          app: null,
          name: 'build',
          head_sha: HEAD_SHA,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'success',
          started_at: AT,
          completed_at: LATER,
        },
        {
          id: 2,
          app: { id: 1 },
          name: '',
          head_sha: HEAD_SHA,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'success',
          started_at: AT,
          completed_at: LATER,
        },
        {
          id: 3,
          app: { id: 1 },
          name: 'wrong-head',
          head_sha: OLD_SHA,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'success',
          started_at: AT,
          completed_at: LATER,
        },
        checkRun({ id: 4, name: 'valid', conclusion: 'success' }),
      ])
    );

    const result = await fetchPullRequestObservations(input);

    expect(result.observations.checks).toEqual([
      expect.objectContaining({ key: 'check:1:valid', id: '4', outcome: 'passed' }),
    ]);
    expect(result.observations.checks.map(entry => entry.key)).not.toContain('check:0:unknown');
    expect(result.observations).toMatchObject({
      checksObserved: true,
      checksComplete: false,
      checksTruncated: true,
      unavailable: [],
    });
    expect(getPrObservationSummary(result.observations, HEAD_SHA)).toMatchObject({
      checks: { total: 1, passed: 1, complete: false },
      truncated: true,
    });
  });

  it('skips malformed legacy statuses instead of forging context or state', async () => {
    mockGetCombinedStatusForRef.mockResolvedValue(
      combinedStatusPage([
        { id: 10, context: 'deploy', state: 'success', updated_at: updatedAt(1) },
        { id: 11, context: '', state: 'success', updated_at: updatedAt(1) },
        { id: 12, context: 'scan', state: 'mystery', updated_at: updatedAt(1) },
        { id: 13, context: 'lint', state: 'success', updated_at: 'not-a-date' },
      ])
    );

    const result = await fetchPullRequestObservations(input);

    expect(result.observations.checks).toEqual([
      expect.objectContaining({ key: 'status:deploy', id: '10', outcome: 'passed' }),
    ]);
    expect(result.observations.checks.map(entry => entry.key)).not.toContain('status:unknown');
    expect(result.observations).toMatchObject({
      checksObserved: true,
      checksComplete: false,
      checksTruncated: true,
      unavailable: [],
    });
  });

  it('bounds check pagination at two pages and the state cap at 200 with explicit flags', async () => {
    const nextLink =
      '<https://api.github.com/repos/acme/widgets/commits/head/check-runs?page=next>; rel="next"';
    mockListForRef.mockImplementation(async (params: { page: number }) =>
      checkRunPage(
        Array.from({ length: 100 }, (_, index) =>
          checkRun({
            id: (params.page - 1) * 100 + index + 1,
            name: `run-${params.page}-${index}`,
          })
        ),
        nextLink
      )
    );

    const result = await fetchPullRequestObservations(input);

    expect(mockListForRef).toHaveBeenCalledTimes(2);
    expect(result.observations.checks).toHaveLength(200);
    expect(result.observations).toMatchObject({
      checksObserved: true,
      checksComplete: false,
      checksTruncated: true,
    });
    expect(getPrObservationSummary(result.observations, HEAD_SHA)).toMatchObject({
      checks: { total: 200, complete: false },
      truncated: true,
    });
  });

  it('paginates legacy statuses and keeps only the latest status per context', async () => {
    mockGetCombinedStatusForRef
      .mockResolvedValueOnce(
        combinedStatusPage(
          [
            { id: 10, context: 'ci/lint', state: 'failure', updated_at: updatedAt(1) },
            { id: 12, context: 'ci/lint', state: 'success', updated_at: updatedAt(2) },
          ],
          '<https://api.github.com/repos/acme/widgets/commits/head/statuses?page=2>; rel="next"'
        )
      )
      .mockResolvedValueOnce(
        combinedStatusPage([
          { id: 11, context: 'ci/build', state: 'pending', updated_at: updatedAt(1) },
        ])
      );

    const result = await fetchPullRequestObservations(input);

    expect(mockGetCombinedStatusForRef).toHaveBeenCalledTimes(2);
    expect(result.observations.checks.map(entry => entry.key).sort()).toEqual([
      'status:ci/build',
      'status:ci/lint',
    ]);
    expect(result.observations.checks.find(entry => entry.key === 'status:ci/lint')).toMatchObject({
      id: '12',
      outcome: 'passed',
    });
    expect(result.observations.checks.find(entry => entry.key === 'status:ci/build')).toMatchObject(
      {
        outcome: 'pending',
      }
    );
    for (const call of mockGetCombinedStatusForRef.mock.calls) {
      expect(call[0]).toMatchObject({ ref: HEAD_SHA });
    }
  });

  it('updates a fetched thread from a subsequent reopening webhook', async () => {
    const fullDatabaseId = '9007199254740993';
    mockGraphQlRequest.mockResolvedValue(
      graphQlResponse(
        graphQlPage({
          nodes: [threadNode('PRRT_thread_900', true, fullDatabaseId)],
        })
      )
    );

    const fetched = await fetchPullRequestObservations(input);
    expect(fetched.observations.threads).toEqual([
      { rootId: fullDatabaseId, threadId: 'PRRT_thread_900', state: 'resolved' },
    ]);

    const event = normalizePrObservationEvent('pull_request_review_thread', {
      installation: { id: '123' },
      repository: { id: '99', full_name: 'acme/widgets' },
      action: 'unresolved',
      pull_request: { number: 7 },
      thread: {
        node_id: 'PRRT_thread_900',
        comments: [{ id: fullDatabaseId }],
      },
    });
    if (!event) throw new Error('Expected a normalized thread event');

    const updated = reducePrObservation(fetched.observations, HEAD_SHA, event);
    expect(updated?.threads).toEqual([
      { rootId: fullDatabaseId, threadId: 'PRRT_thread_900', state: 'unresolved' },
    ]);
    expect(updated?.threadsTruncated).toBe(false);
    expect(getPrObservationSummary(updated, HEAD_SHA)).toMatchObject({
      unresolvedThreads: 1,
      threadsComplete: true,
      truncated: false,
    });
  });

  it('caps review-thread pagination at the state limit without requesting another page', async () => {
    const page = (pageNumber: number) =>
      graphQlPage({
        nodes: Array.from({ length: 100 }, (_, index) =>
          threadNode(`PRRT_${pageNumber}_${index}`, false, pageNumber * 1000 + index)
        ),
        hasNextPage: true,
        endCursor: `cursor-${pageNumber}`,
      });
    mockGraphQlRequest
      .mockResolvedValueOnce(graphQlResponse(page(1)))
      .mockResolvedValueOnce(graphQlResponse(page(2)));

    const result = await fetchPullRequestObservations(input);

    expect(mockGraphQlRequest).toHaveBeenCalledTimes(2);
    expect(result.observations.threads).toHaveLength(200);
    expect(result.observations).toMatchObject({
      threadsObserved: true,
      threadsComplete: false,
      threadsTruncated: true,
    });
    expect(getPrObservationSummary(result.observations, HEAD_SHA)).toMatchObject({
      unresolvedThreads: 200,
      threadsComplete: false,
      truncated: true,
    });
  });

  it('passes the shared abort signal to every Octokit request', async () => {
    const controller = new AbortController();

    await fetchPullRequestObservations({ ...input, signal: controller.signal });

    expect(mockOctokitConstructor).toHaveBeenCalledWith({
      auth: 'installation-token',
      request: { signal: controller.signal },
    });
  });

  it('reads latest per-context statuses from the combined status endpoint within two pages', async () => {
    const nextLink =
      '<https://api.github.com/repos/acme/widgets/commits/head/status?page=2>; rel="next"';
    mockGetCombinedStatusForRef.mockImplementation(async (params: { page: number }) =>
      combinedStatusPage(
        [
          {
            id: params.page * 100,
            context: `ci/context-${params.page}`,
            state: 'success',
            updated_at: updatedAt(params.page),
          },
        ],
        nextLink
      )
    );

    const result = await fetchPullRequestObservations(input);

    expect(mockGetCombinedStatusForRef).toHaveBeenCalledTimes(2);
    expect(mockGetCombinedStatusForRef).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'widgets',
        ref: HEAD_SHA,
        per_page: 100,
        page: 1,
      })
    );
    expect(result.observations.checksTruncated).toBe(true);
  });

  it('stops sibling pagination after a REST rate limit and propagates the typed error', async () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    mockListForRef.mockRejectedValue(
      Object.assign(new Error('rate limit exceeded'), {
        status: 429,
        response: { headers: { 'retry-after': '30' } },
      })
    );
    mockGetCombinedStatusForRef.mockImplementation(async ({ page }: { page: number }) => {
      await Promise.resolve();
      return combinedStatusPage(
        [{ id: 10, context: 'deploy', state: 'success', updated_at: updatedAt(1) }],
        page === 1
          ? '<https://api.github.com/repos/acme/widgets/commits/head/status?page=2>; rel="next"'
          : undefined
      );
    });

    await expect(fetchPullRequestObservations(input)).rejects.toMatchObject({
      name: 'GitHubRateLimitError',
      resetAt: new Date(now + 30_000),
    });
    expect(mockGetCombinedStatusForRef).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['type', { message: 'slow down', type: 'RATE_LIMITED' }],
    ['extension code', { message: 'slow down', extensions: { code: 'SECONDARY_RATE_LIMIT' } }],
  ])('detects a GraphQL rate limit from a %s in a later error entry', async (_label, rateEntry) => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    mockGraphQlRequest.mockResolvedValue({
      data: {
        data: null,
        errors: [
          { message: 'Resource not accessible by integration', type: 'FORBIDDEN' },
          rateEntry,
        ],
      },
      headers: { 'retry-after': '45' },
    });

    await expect(fetchPullRequestObservations(input)).rejects.toMatchObject({
      name: 'GitHubRateLimitError',
      resetAt: new Date(now + 45_000),
    });
  });
});
