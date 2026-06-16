const mockGraphql = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    graphql: mockGraphql,
  })),
}));

import {
  fetchGitHubReviewThreadResolutionCandidates,
  GITHUB_REVIEW_THREAD_RESOLUTION_MARKER_PREFIX,
  resolveAddressedGitHubReviewThreads,
} from './github-review-thread-resolution';

const SECRET = 'test-review-thread-resolution-secret';
const ROOT_BODY = [
  '**WARNING:** The cache key omits the tenant id.',
  '',
  'This can leak cached data across tenants.',
  '',
  '---',
  'Reply with `@kilocode-bot fix it` to have Kilo Code address this issue.',
].join('\n');

const BASE_PARAMS = {
  appType: 'standard' as const,
  owner: 'acme',
  repo: 'widgets',
  prNumber: 7,
  reviewId: 'review-1',
  expectedHeadSha: 'head-sha',
  secret: SECRET,
};

beforeEach(() => {
  mockGraphql.mockReset();
});

function threadNode(
  overrides: Record<string, unknown> = {},
  commentOverrides: Record<string, unknown> = {}
) {
  return {
    id: 'PRRT_thread_1',
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    path: 'src/cache.ts',
    line: 42,
    comments: {
      totalCount: 1,
      nodes: [
        {
          id: 'PRRC_comment_1',
          body: ROOT_BODY,
          path: 'src/cache.ts',
          line: 42,
          viewerDidAuthor: true,
          ...commentOverrides,
        },
      ],
    },
    ...overrides,
  };
}

function reviewThreadState(
  options: {
    state?: 'OPEN' | 'CLOSED' | 'MERGED';
    headRefOid?: string;
    nodes?: Array<Record<string, unknown> | null> | null;
    hasNextPage?: boolean;
  } = {}
) {
  return {
    repository: {
      pullRequest: {
        state: options.state ?? 'OPEN',
        headRefOid: options.headRefOid ?? 'head-sha',
        reviewThreads: {
          pageInfo: { hasNextPage: options.hasNextPage ?? false },
          nodes: options.nodes ?? [threadNode()],
        },
      },
    },
  };
}

function assistantMarker(entries: Array<{ id: string; token: string }>): string {
  return `Review complete.\n${GITHUB_REVIEW_THREAD_RESOLUTION_MARKER_PREFIX}${JSON.stringify(entries)}`;
}

describe('github-review-thread-resolution', () => {
  it('queries bounded candidates, validates the capability token, and resolves the exact thread', async () => {
    mockGraphql
      .mockResolvedValueOnce(reviewThreadState({ hasNextPage: true }))
      .mockResolvedValueOnce(reviewThreadState())
      .mockResolvedValueOnce({
        resolveReviewThread: {
          thread: {
            id: 'PRRT_thread_1',
            isResolved: true,
          },
        },
      });

    const candidates = await fetchGitHubReviewThreadResolutionCandidates({
      ...BASE_PARAMS,
      token: 'installation-token',
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      threadId: 'PRRT_thread_1',
      path: 'src/cache.ts',
      line: 42,
      isOutdated: false,
      body: ROOT_BODY,
    });
    expect(candidates[0].token).toMatch(/^[0-9a-f]{64}$/);
    expect(mockGraphql.mock.calls[0][0]).toContain('reviewThreads(first: 100)');
    expect(mockGraphql.mock.calls[0][1]).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
    });

    const result = await resolveAddressedGitHubReviewThreads({
      ...BASE_PARAMS,
      installationId: 'installation-1',
      assistantMessageText: assistantMarker([
        { id: candidates[0].threadId, token: candidates[0].token },
      ]),
    });

    expect(result).toEqual({ status: 'resolved', requestedCount: 1, resolvedCount: 1 });
    expect(mockGraphql.mock.calls[2][0]).toContain('resolveReviewThread');
    expect(mockGraphql.mock.calls[2][1]).toEqual({ threadId: 'PRRT_thread_1' });
  });

  it.each([
    {
      name: 'rejects comments not authored by the viewer',
      run: async () => {
        mockGraphql.mockResolvedValueOnce(
          reviewThreadState({ nodes: [threadNode({}, { viewerDidAuthor: false })] })
        );
        const candidates = await fetchGitHubReviewThreadResolutionCandidates({
          ...BASE_PARAMS,
          token: 'installation-token',
        });
        expect(candidates).toEqual([]);
      },
    },
    {
      name: 'rejects threads with replies',
      run: async () => {
        mockGraphql.mockResolvedValueOnce(
          reviewThreadState({ nodes: [threadNode({ comments: { totalCount: 2, nodes: [] } })] })
        );
        const candidates = await fetchGitHubReviewThreadResolutionCandidates({
          ...BASE_PARAMS,
          token: 'installation-token',
        });
        expect(candidates).toEqual([]);
      },
    },
    {
      name: 'rejects closed pull requests',
      run: async () => {
        mockGraphql.mockResolvedValueOnce(reviewThreadState({ state: 'CLOSED' }));
        const candidates = await fetchGitHubReviewThreadResolutionCandidates({
          ...BASE_PARAMS,
          token: 'installation-token',
        });
        expect(candidates).toEqual([]);
      },
    },
    {
      name: 'rejects stale pull request heads before mutation',
      run: async () => {
        mockGraphql.mockResolvedValueOnce(reviewThreadState({ headRefOid: 'new-head' }));
        const result = await resolveAddressedGitHubReviewThreads({
          ...BASE_PARAMS,
          installationId: 'installation-1',
          assistantMessageText: assistantMarker([{ id: 'PRRT_thread_1', token: '0'.repeat(64) }]),
        });
        expect(result).toEqual({
          status: 'stale-pull-request',
          requestedCount: 1,
          resolvedCount: 0,
        });
      },
    },
    {
      name: 'rejects stale comment bodies before mutation',
      run: async () => {
        mockGraphql.mockResolvedValueOnce(reviewThreadState());
        const [candidate] = await fetchGitHubReviewThreadResolutionCandidates({
          ...BASE_PARAMS,
          token: 'installation-token',
        });
        mockGraphql.mockResolvedValueOnce(
          reviewThreadState({
            nodes: [threadNode({}, { body: ROOT_BODY.replace('tenant id', 'workspace id') })],
          })
        );
        const result = await resolveAddressedGitHubReviewThreads({
          ...BASE_PARAMS,
          installationId: 'installation-1',
          assistantMessageText: assistantMarker([
            { id: candidate.threadId, token: candidate.token },
          ]),
        });
        expect(result).toEqual({ status: 'invalid-request', requestedCount: 1, resolvedCount: 0 });
      },
    },
    {
      name: 'rejects malformed markers',
      run: async () => {
        const result = await resolveAddressedGitHubReviewThreads({
          ...BASE_PARAMS,
          installationId: 'installation-1',
          assistantMessageText: `Review complete.\n${GITHUB_REVIEW_THREAD_RESOLUTION_MARKER_PREFIX}{not-json}`,
        });
        expect(result).toEqual({ status: 'invalid-marker', requestedCount: 0, resolvedCount: 0 });
      },
    },
    {
      name: 'rejects tampered tokens before mutation',
      run: async () => {
        mockGraphql.mockResolvedValueOnce(reviewThreadState());
        const result = await resolveAddressedGitHubReviewThreads({
          ...BASE_PARAMS,
          installationId: 'installation-1',
          assistantMessageText: assistantMarker([{ id: 'PRRT_thread_1', token: '0'.repeat(64) }]),
        });
        expect(result).toEqual({ status: 'invalid-request', requestedCount: 1, resolvedCount: 0 });
      },
    },
  ])('$name', async ({ run }) => {
    await run();
    const mutationCalls = mockGraphql.mock.calls.filter(call =>
      String(call[0]).includes('resolveReviewThread')
    );
    expect(mutationCalls).toHaveLength(0);
  });

  it('throws when GitHub does not confirm a resolved mutation response', async () => {
    mockGraphql
      .mockResolvedValueOnce(reviewThreadState())
      .mockResolvedValueOnce(reviewThreadState())
      .mockResolvedValueOnce({
        resolveReviewThread: {
          thread: {
            id: 'PRRT_thread_1',
            isResolved: false,
          },
        },
      });

    const [candidate] = await fetchGitHubReviewThreadResolutionCandidates({
      ...BASE_PARAMS,
      token: 'installation-token',
    });

    await expect(
      resolveAddressedGitHubReviewThreads({
        ...BASE_PARAMS,
        installationId: 'installation-1',
        assistantMessageText: assistantMarker([{ id: candidate.threadId, token: candidate.token }]),
      })
    ).rejects.toThrow('GitHub resolveReviewThread mutation did not confirm thread resolution');
  });
});
