const mockGenerateToken = jest.fn();
const mockOctokitConstructor = jest.fn();
const mockPullsGet = jest.fn();
const mockListForRef = jest.fn();
const mockListCommitStatusesForRef = jest.fn();
const mockGraphQlRequest = jest.fn();
const mockDelay = jest.fn().mockResolvedValue(undefined);

jest.mock('node:timers/promises', () => ({
  setTimeout: (...args: unknown[]) => mockDelay(...args),
}));

jest.mock('./adapter', () => ({
  generateGitHubInstallationToken: (...args: unknown[]) => mockGenerateToken(...args),
}));

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation((options: unknown) => {
    mockOctokitConstructor(options);
    return {
      pulls: { get: mockPullsGet },
      checks: { listForRef: mockListForRef },
      repos: { listCommitStatusesForRef: mockListCommitStatusesForRef },
      request: mockGraphQlRequest,
    };
  }),
}));

import { fetchPullRequestStatus } from './pr-status';

const HEAD_SHA = '1111111111111111111111111111111111111111';
const BASE_SHA = '2222222222222222222222222222222222222222';

const input = {
  installationId: '123',
  integrationId: 'integration-1',
  appType: 'standard' as const,
  owner: 'acme',
  repo: 'widgets',
  number: 7,
};

type PullOverrides = {
  number: number;
  html_url: string;
  title: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string | null;
  headSha: string;
  headRef: string;
  headRepo: string | null;
  baseSha: string;
  baseRepo: string;
};

function pullResponse(overrides: Partial<PullOverrides> = {}) {
  return {
    data: {
      number: overrides.number ?? 7,
      html_url: overrides.html_url ?? 'https://github.com/acme/widgets/pull/7',
      title: overrides.title ?? 'Add feature',
      state: overrides.state ?? 'open',
      draft: overrides.draft ?? false,
      merged: overrides.merged ?? false,
      mergeable: overrides.mergeable === undefined ? true : overrides.mergeable,
      mergeable_state:
        overrides.mergeable_state === undefined ? 'clean' : overrides.mergeable_state,
      head: {
        sha: overrides.headSha ?? HEAD_SHA,
        ref: overrides.headRef ?? 'feature',
        repo:
          overrides.headRepo === null ? null : { full_name: overrides.headRepo ?? 'acme/widgets' },
      },
      base: {
        sha: overrides.baseSha ?? BASE_SHA,
        ref: 'main',
        repo: { full_name: overrides.baseRepo ?? 'acme/widgets' },
      },
    },
  };
}

function restPage(items: unknown[], link?: string) {
  return { data: items, headers: link ? { link } : {} };
}

function checkRunPage(items: unknown[], link?: string) {
  return { data: { check_runs: items }, headers: link ? { link } : {} };
}

function graphQlPage(
  options: {
    reviewDecision?: string | null;
    resolved?: number;
    unresolved?: number;
    nodes?: Array<{ isResolved: boolean }>;
    hasNextPage?: boolean;
    endCursor?: string | null;
  } = {}
) {
  const nodes = options.nodes ?? [
    ...Array.from({ length: options.resolved ?? 0 }, () => ({ isResolved: true })),
    ...Array.from({ length: options.unresolved ?? 0 }, () => ({ isResolved: false })),
  ];
  return {
    reviewDecision: options.reviewDecision ?? null,
    reviewThreads: {
      nodes,
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

beforeEach(() => {
  mockGenerateToken.mockReset().mockResolvedValue({
    token: 'installation-token',
    expires_at: null,
  });
  mockOctokitConstructor.mockReset();
  mockPullsGet.mockReset().mockResolvedValue(pullResponse());
  mockListForRef.mockReset().mockResolvedValue(checkRunPage([]));
  mockListCommitStatusesForRef.mockReset().mockResolvedValue(restPage([]));
  mockGraphQlRequest.mockReset().mockResolvedValue(graphQlResponse(graphQlPage()));
  mockDelay.mockClear();
});

describe('fetchPullRequestStatus', () => {
  it('generates the agent installation token with the exact app and integration association', async () => {
    await fetchPullRequestStatus({ ...input, appType: 'lite' });

    expect(mockGenerateToken).toHaveBeenCalledWith('123', 'lite', 'integration-1', 'agent');
    expect(mockOctokitConstructor).toHaveBeenCalledWith({
      auth: 'installation-token',
      request: { timeout: 10_000 },
    });
  });

  it('retries mergeability computation within a bound before returning a snapshot', async () => {
    mockPullsGet
      .mockResolvedValueOnce(pullResponse({ mergeable: null }))
      .mockResolvedValueOnce(pullResponse({ mergeable: false, mergeable_state: 'dirty' }));
    expect((await fetchPullRequestStatus(input)).mergeable).toBe(false);
    expect(mockPullsGet).toHaveBeenCalledTimes(2);
    expect(mockDelay).toHaveBeenCalledWith(1_000);
  });

  it('keeps mergeability unknown after two bounded retries rather than waiting indefinitely', async () => {
    mockPullsGet.mockResolvedValue(pullResponse({ mergeable: null, mergeable_state: 'unknown' }));
    expect((await fetchPullRequestStatus(input)).mergeable).toBeNull();
    expect(mockPullsGet).toHaveBeenCalledTimes(3);
    expect(mockDelay).toHaveBeenCalledTimes(2);
  });

  it('does not retry mergeability for a closed draft PR', async () => {
    mockPullsGet.mockResolvedValue(pullResponse({ state: 'closed', draft: true, mergeable: null }));
    expect((await fetchPullRequestStatus(input)).state).toBe('closed');
    expect(mockPullsGet).toHaveBeenCalledTimes(1);
    expect(mockDelay).not.toHaveBeenCalled();
  });

  it('returns pull metadata and counts successful, failed, pending, and unresolved data', async () => {
    mockListForRef.mockResolvedValue(
      checkRunPage([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
        { status: 'in_progress', conclusion: null },
      ])
    );
    mockListCommitStatusesForRef.mockResolvedValue(
      restPage([
        { id: 1, context: 'deploy', state: 'success', updated_at: updatedAt(1) },
        { id: 2, context: 'lint', state: 'failure', updated_at: updatedAt(1) },
        { id: 3, context: 'e2e', state: 'pending', updated_at: updatedAt(1) },
      ])
    );
    mockGraphQlRequest.mockResolvedValue(
      graphQlResponse(
        graphQlPage({ resolved: 1, unresolved: 1, reviewDecision: 'CHANGES_REQUESTED' })
      )
    );

    const status = await fetchPullRequestStatus(input);

    expect(status).toMatchObject({
      url: 'https://github.com/acme/widgets/pull/7',
      number: 7,
      state: 'open',
      title: 'Add feature',
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      headRef: 'feature',
      baseRepoFullName: 'acme/widgets',
      headRepoFullName: 'acme/widgets',
      reviewDecision: 'changes_requested',
      mergeable: true,
      mergeableState: 'clean',
      unresolvedThreads: 1,
      threadsTruncated: false,
      unavailable: [],
    });
    expect(status.checks).toEqual({
      total: 6,
      passed: 2,
      failed: 2,
      pending: 2,
      skipped: 0,
      unknown: 0,
      truncated: false,
    });
    expect(Number.isNaN(Date.parse(status.fetchedAt))).toBe(false);
    expect(mockListForRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: HEAD_SHA, filter: 'latest', per_page: 100, page: 1 })
    );
    expect(mockListCommitStatusesForRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: HEAD_SHA, per_page: 100, page: 1 })
    );
  });

  it('returns a zeroed checks summary when both check sources succeed with no data', async () => {
    const status = await fetchPullRequestStatus(input);

    expect(status.checks).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      unknown: 0,
      truncated: false,
    });
    expect(status.unresolvedThreads).toBe(0);
    expect(status.unavailable).toEqual([]);
  });

  it('classifies completed, skipped, failing, pending, and unrecognized check runs', async () => {
    mockListForRef.mockResolvedValue(
      checkRunPage([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'neutral' },
        { status: 'completed', conclusion: 'skipped' },
        { status: 'completed', conclusion: 'failure' },
        { status: 'completed', conclusion: 'cancelled' },
        { status: 'completed', conclusion: 'timed_out' },
        { status: 'completed', conclusion: 'action_required' },
        { status: 'completed', conclusion: 'stale' },
        { status: 'completed', conclusion: 'startup_failure' },
        { status: 'completed', conclusion: 'mystery' },
        { status: 'completed', conclusion: null },
        { status: 'in_progress', conclusion: null },
        { status: 'queued', conclusion: null },
      ])
    );

    const status = await fetchPullRequestStatus(input);

    expect(status.checks).toEqual({
      total: 13,
      passed: 1,
      failed: 6,
      pending: 2,
      skipped: 2,
      unknown: 2,
      truncated: false,
    });
  });

  it('keeps only the latest legacy status per context by id and timestamp', async () => {
    mockListCommitStatusesForRef.mockResolvedValue(
      restPage([
        { id: 10, context: 'ci/lint', state: 'failure', updated_at: updatedAt(1) },
        { id: 12, context: 'ci/lint', state: 'success', updated_at: updatedAt(2) },
        { id: 20, context: 'ci/build', state: 'success', updated_at: updatedAt(1) },
        { id: 20, context: 'ci/build', state: 'failure', updated_at: updatedAt(3) },
      ])
    );

    const status = await fetchPullRequestStatus(input);

    expect(status.checks).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      pending: 0,
      skipped: 0,
      unknown: 0,
      truncated: false,
    });
  });

  it('treats GraphQL errors returned with HTTP 200 as an unavailable review leg', async () => {
    mockGraphQlRequest.mockResolvedValue({
      data: {
        data: null,
        errors: [{ message: 'Resource not accessible by integration' }],
      },
    });

    const status = await fetchPullRequestStatus(input);

    expect(status.unavailable).toEqual(['reviews']);
    expect(status.reviewDecision).toBeNull();
    expect(status.unresolvedThreads).toBeNull();
    expect(status.threadsTruncated).toBe(false);
    expect(status.checks).not.toBeNull();
  });

  it('treats a review payload without thread nodes as unavailable rather than zero unresolved', async () => {
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

    const status = await fetchPullRequestStatus(input);

    expect(status.unavailable).toEqual(['reviews']);
    expect(status.reviewDecision).toBeNull();
    expect(status.unresolvedThreads).toBeNull();
  });

  it('preserves successful status data when the check-run leg fails', async () => {
    mockListForRef.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    mockListCommitStatusesForRef.mockResolvedValue(
      restPage([{ id: 1, context: 'deploy', state: 'success', updated_at: updatedAt(1) }])
    );
    mockGraphQlRequest.mockResolvedValue(
      graphQlResponse(graphQlPage({ reviewDecision: 'APPROVED' }))
    );

    const status = await fetchPullRequestStatus(input);

    expect(status.checks).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
      unknown: 0,
      truncated: true,
    });
    expect(status.unavailable).toEqual(['checks']);
    expect(status.reviewDecision).toBe('approved');
  });

  it('preserves successful check data when the legacy status leg fails', async () => {
    mockListForRef.mockResolvedValue(
      checkRunPage([{ status: 'completed', conclusion: 'success' }])
    );
    mockListCommitStatusesForRef.mockRejectedValue(new Error('Resource not accessible'));

    const status = await fetchPullRequestStatus(input);

    expect(status.checks).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
      unknown: 0,
      truncated: true,
    });
    expect(status.unavailable).toEqual(['statuses']);
  });

  it('returns null checks only when both check sources fail', async () => {
    mockListForRef.mockRejectedValue(new Error('Forbidden'));
    mockListCommitStatusesForRef.mockRejectedValue(new Error('Forbidden'));

    const status = await fetchPullRequestStatus(input);

    expect(status.checks).toBeNull();
    expect(status.unavailable).toEqual(['checks', 'statuses']);
    expect(status.reviewDecision).toBeNull();
  });

  it('paginates check runs using the page-length fallback and pins every read to the initial head', async () => {
    mockListForRef
      .mockResolvedValueOnce(
        checkRunPage(
          Array.from({ length: 100 }, () => ({
            status: 'completed',
            conclusion: 'success',
          }))
        )
      )
      .mockResolvedValueOnce(checkRunPage([{ status: 'completed', conclusion: 'failure' }]));

    const status = await fetchPullRequestStatus(input);

    expect(status.checks).toEqual({
      total: 101,
      passed: 100,
      failed: 1,
      pending: 0,
      skipped: 0,
      unknown: 0,
      truncated: false,
    });
    expect(mockListForRef).toHaveBeenCalledTimes(2);
    for (const call of mockListForRef.mock.calls) {
      expect(call[0]).toMatchObject({ ref: HEAD_SHA });
    }
  });

  it('follows a next link even when the page is shorter than the page size', async () => {
    mockListForRef
      .mockResolvedValueOnce(
        checkRunPage(
          [{ status: 'completed', conclusion: 'success' }],
          '<https://api.github.com/repos/acme/widgets/commits/head/check-runs?page=2>; rel="next"'
        )
      )
      .mockResolvedValueOnce(checkRunPage([{ status: 'completed', conclusion: 'failure' }]));

    const status = await fetchPullRequestStatus(input);

    expect(status.checks).toMatchObject({ total: 2, passed: 1, failed: 1, truncated: false });
    expect(mockListForRef).toHaveBeenCalledTimes(2);
  });

  it('marks checks truncated at the five-page cap', async () => {
    mockListForRef.mockImplementation(async () =>
      checkRunPage(
        Array.from({ length: 100 }, () => ({
          status: 'completed',
          conclusion: 'success',
        })),
        '<https://api.github.com/repos/acme/widgets/commits/head/check-runs?page=next>; rel="next"'
      )
    );

    const status = await fetchPullRequestStatus(input);

    expect(mockListForRef).toHaveBeenCalledTimes(5);
    expect(status.checks).toMatchObject({ total: 500, passed: 500, truncated: true });
  });

  it('paginates legacy statuses and pins every read to the initial head', async () => {
    mockListCommitStatusesForRef
      .mockResolvedValueOnce(
        restPage(
          Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            context: `ci/context-${index}`,
            state: 'success',
            updated_at: updatedAt(1),
          }))
        )
      )
      .mockResolvedValueOnce(
        restPage([{ id: 101, context: 'ci/extra', state: 'failure', updated_at: updatedAt(2) }])
      );

    const status = await fetchPullRequestStatus(input);

    expect(status.checks).toMatchObject({ total: 101, passed: 100, failed: 1, truncated: false });
    expect(mockListCommitStatusesForRef).toHaveBeenCalledTimes(2);
    for (const call of mockListCommitStatusesForRef.mock.calls) {
      expect(call[0]).toMatchObject({ ref: HEAD_SHA });
    }
  });

  it('counts unresolved threads across review-thread pages', async () => {
    mockGraphQlRequest
      .mockResolvedValueOnce(
        graphQlResponse(
          graphQlPage({
            reviewDecision: 'APPROVED',
            nodes: Array.from({ length: 100 }, () => ({ isResolved: false })),
            hasNextPage: true,
            endCursor: 'thread-cursor-1',
          })
        )
      )
      .mockResolvedValueOnce(graphQlResponse(graphQlPage({ nodes: [{ isResolved: false }] })));

    const status = await fetchPullRequestStatus(input);

    expect(status.unresolvedThreads).toBe(101);
    expect(status.threadsTruncated).toBe(false);
    expect(status.reviewDecision).toBe('approved');
    expect(mockGraphQlRequest).toHaveBeenCalledTimes(2);
    expect(mockGraphQlRequest.mock.calls[1]?.[1]).toMatchObject({
      variables: { after: 'thread-cursor-1' },
    });
  });

  it('marks review threads truncated at the five-page cap', async () => {
    for (let page = 1; page <= 5; page += 1) {
      mockGraphQlRequest.mockResolvedValueOnce(
        graphQlResponse(
          graphQlPage({
            nodes: Array.from({ length: 100 }, () => ({ isResolved: false })),
            hasNextPage: true,
            endCursor: `thread-cursor-${page}`,
          })
        )
      );
    }

    const status = await fetchPullRequestStatus(input);

    expect(mockGraphQlRequest).toHaveBeenCalledTimes(5);
    expect(status.unresolvedThreads).toBe(500);
    expect(status.threadsTruncated).toBe(true);
  });

  it('maps draft and merged pull requests to distinct states', async () => {
    mockPullsGet.mockResolvedValueOnce(pullResponse({ draft: true }));
    await expect(fetchPullRequestStatus(input)).resolves.toMatchObject({ state: 'draft' });

    mockPullsGet.mockResolvedValueOnce(pullResponse({ state: 'closed', merged: true }));
    await expect(fetchPullRequestStatus(input)).resolves.toMatchObject({ state: 'merged' });
  });

  it('propagates a core pull request read failure before starting the CI legs', async () => {
    mockPullsGet.mockRejectedValue(new Error('Not Found'));

    await expect(fetchPullRequestStatus(input)).rejects.toThrow('Not Found');
    expect(mockListForRef).not.toHaveBeenCalled();
    expect(mockListCommitStatusesForRef).not.toHaveBeenCalled();
    expect(mockGraphQlRequest).not.toHaveBeenCalled();
  });
});
