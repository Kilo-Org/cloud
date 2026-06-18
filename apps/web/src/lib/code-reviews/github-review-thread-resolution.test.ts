import { createHash } from 'node:crypto';

const mockGraphql = jest.fn();
const mockGenerateGitHubInstallationToken = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    graphql: mockGraphql,
  })),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (...args: unknown[]) =>
    mockGenerateGitHubInstallationToken(...args),
}));

import {
  fetchGitHubReviewThreadResolutionCandidates,
  resolveAddressedGitHubReviewThreads,
} from './github-review-thread-resolution';
import type { GitHubReviewThreadResolutionCandidateState } from '@kilocode/db/schema-types';

const ROOT_BODY = [
  '**WARNING:** The cache key omits the tenant id.',
  '',
  'This can leak cached data across tenants.',
  '',
  '---',
  'Reply with `@kilocode-bot fix it` to have Kilo Code address this issue.',
].join('\n');

const BASE_PARAMS = {
  owner: 'acme',
  repo: 'widgets',
  prNumber: 7,
  expectedHeadSha: 'head-sha',
};

beforeEach(() => {
  mockGraphql.mockReset();
  mockGenerateGitHubInstallationToken.mockReset();
  mockGenerateGitHubInstallationToken.mockResolvedValue({
    token: 'resolver-installation-token',
    expires_at: '2099-01-01T00:00:00.000Z',
  });
});

function rootBodySha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function structuredOutput(threadIds: string[]) {
  return { addressedReviewThreadIds: threadIds };
}

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

function persistedCandidate(
  threadId = 'PRRT_thread_1',
  body = ROOT_BODY
): GitHubReviewThreadResolutionCandidateState {
  return { threadId, rootBodySha256: rootBodySha256(body) };
}

function mutationCalls() {
  return mockGraphql.mock.calls.filter(call => String(call[0]).includes('resolveReviewThread'));
}

describe('github-review-thread-resolution', () => {
  it('queries bounded candidates, stores root body hashes, and resolves structured selections', async () => {
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

    expect(candidates).toEqual([
      expect.objectContaining({
        threadId: 'PRRT_thread_1',
        path: 'src/cache.ts',
        line: 42,
        isOutdated: false,
        body: ROOT_BODY,
        rootBodySha256: rootBodySha256(ROOT_BODY),
      }),
    ]);
    expect(mockGraphql.mock.calls[0][0]).toContain('reviewThreads(first: 100)');
    expect(mockGraphql.mock.calls[0][1]).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
    });

    const resolvedCount = await resolveAddressedGitHubReviewThreads({
      ...BASE_PARAMS,
      installationId: 'installation-1',
      persistedCandidates: candidates.map(candidate => ({
        threadId: candidate.threadId,
        rootBodySha256: candidate.rootBodySha256,
      })),
      structuredOutput: structuredOutput(['PRRT_thread_1']),
    });

    expect(mockGenerateGitHubInstallationToken).toHaveBeenCalledWith('installation-1', 'standard');
    expect(resolvedCount).toBe(1);
    expect(mockGraphql.mock.calls[2][0]).toContain('resolveReviewThread');
    expect(mockGraphql.mock.calls[2][1]).toEqual({ threadId: 'PRRT_thread_1' });
  });

  it('hashes the complete root body before truncating candidate display text', async () => {
    const longBody = [
      '**WARNING:** ' + 'A'.repeat(2500),
      '',
      '---',
      'Reply with `@kilocode-bot fix it` to have Kilo Code address this issue.',
    ].join('\n');
    mockGraphql.mockResolvedValueOnce(
      reviewThreadState({ nodes: [threadNode({}, { body: longBody })] })
    );

    const [candidate] = await fetchGitHubReviewThreadResolutionCandidates({
      ...BASE_PARAMS,
      token: 'installation-token',
    });

    expect(candidate.body).toHaveLength(2000);
    expect(candidate.rootBodySha256).toBe(rootBodySha256(longBody));
    expect(candidate.rootBodySha256).not.toBe(rootBodySha256(candidate.body));
  });

  it.each([
    {
      name: 'rejects comments not authored by the viewer',
      nodes: [threadNode({}, { viewerDidAuthor: false })],
    },
    {
      name: 'rejects threads with replies',
      nodes: [threadNode({ comments: { totalCount: 2, nodes: [] } })],
    },
    {
      name: 'rejects closed pull requests',
      state: 'CLOSED' as const,
      nodes: undefined,
    },
  ])('$name during candidate lookup', async ({ state, nodes }) => {
    mockGraphql.mockResolvedValueOnce(reviewThreadState({ state, nodes }));

    const candidates = await fetchGitHubReviewThreadResolutionCandidates({
      ...BASE_PARAMS,
      token: 'installation-token',
    });

    expect(candidates).toEqual([]);
    expect(mutationCalls()).toHaveLength(0);
  });

  it.each([
    { name: 'missing output', structuredOutput: undefined },
    { name: 'malformed output', structuredOutput: { addressedReviewThreadIds: 'PRRT_thread_1' } },
    {
      name: 'additional output properties',
      structuredOutput: { addressedReviewThreadIds: ['PRRT_thread_1'], extra: true },
    },
    {
      name: 'duplicate selections',
      structuredOutput: { addressedReviewThreadIds: ['PRRT_thread_1', 'PRRT_thread_1'] },
    },
    {
      name: 'oversized selections',
      structuredOutput: {
        addressedReviewThreadIds: Array.from({ length: 21 }, (_, i) => `t-${i}`),
      },
    },
    {
      name: 'oversized IDs',
      structuredOutput: { addressedReviewThreadIds: ['x'.repeat(513)] },
    },
  ])('returns 0 for $name before fetching GitHub state', async ({ structuredOutput }) => {
    const resolvedCount = await resolveAddressedGitHubReviewThreads({
      ...BASE_PARAMS,
      installationId: 'installation-1',
      persistedCandidates: [persistedCandidate()],
      structuredOutput,
    });

    expect(resolvedCount).toBe(0);
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it('returns 0 for empty or unknown selections before mutation', async () => {
    await expect(
      resolveAddressedGitHubReviewThreads({
        ...BASE_PARAMS,
        installationId: 'installation-1',
        persistedCandidates: [persistedCandidate()],
        structuredOutput: structuredOutput([]),
      })
    ).resolves.toBe(0);
    await expect(
      resolveAddressedGitHubReviewThreads({
        ...BASE_PARAMS,
        installationId: 'installation-1',
        persistedCandidates: [persistedCandidate()],
        structuredOutput: structuredOutput(['PRRT_unknown']),
      })
    ).resolves.toBe(0);

    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'stale pull request heads',
      state: reviewThreadState({ headRefOid: 'new-head' }),
    },
    {
      name: 'changed root comment bodies',
      state: reviewThreadState({
        nodes: [threadNode({}, { body: ROOT_BODY.replace('tenant id', 'workspace id') })],
      }),
    },
    {
      name: 'resolved threads',
      state: reviewThreadState({ nodes: [threadNode({ isResolved: true })] }),
    },
    {
      name: 'lost resolution capability',
      state: reviewThreadState({ nodes: [threadNode({ viewerCanResolve: false })] }),
    },
    {
      name: 'new replies',
      state: reviewThreadState({ nodes: [threadNode({ comments: { totalCount: 2, nodes: [] } })] }),
    },
    {
      name: 'lost viewer ownership',
      state: reviewThreadState({ nodes: [threadNode({}, { viewerDidAuthor: false })] }),
    },
  ])('returns 0 for $name before mutation', async ({ state }) => {
    mockGraphql.mockResolvedValueOnce(state);

    const resolvedCount = await resolveAddressedGitHubReviewThreads({
      ...BASE_PARAMS,
      installationId: 'installation-1',
      persistedCandidates: [persistedCandidate()],
      structuredOutput: structuredOutput(['PRRT_thread_1']),
    });

    expect(resolvedCount).toBe(0);
    expect(mutationCalls()).toHaveLength(0);
  });

  it('validates every selection before resolving the first thread', async () => {
    const secondBody = ROOT_BODY.replace('tenant id', 'workspace id');
    mockGraphql.mockResolvedValueOnce(
      reviewThreadState({
        nodes: [
          threadNode(),
          threadNode({ id: 'PRRT_thread_2', line: 43 }, { id: 'PRRC_comment_2', body: secondBody }),
        ],
      })
    );

    const resolvedCount = await resolveAddressedGitHubReviewThreads({
      ...BASE_PARAMS,
      installationId: 'installation-1',
      persistedCandidates: [persistedCandidate(), persistedCandidate('PRRT_thread_2', ROOT_BODY)],
      structuredOutput: structuredOutput(['PRRT_thread_1', 'PRRT_thread_2']),
    });

    expect(resolvedCount).toBe(0);
    expect(mutationCalls()).toHaveLength(0);
  });

  it('throws when GitHub does not confirm a resolved mutation response', async () => {
    mockGraphql.mockResolvedValueOnce(reviewThreadState()).mockResolvedValueOnce({
      resolveReviewThread: {
        thread: {
          id: 'PRRT_thread_1',
          isResolved: false,
        },
      },
    });

    await expect(
      resolveAddressedGitHubReviewThreads({
        ...BASE_PARAMS,
        installationId: 'installation-1',
        persistedCandidates: [persistedCandidate()],
        structuredOutput: structuredOutput(['PRRT_thread_1']),
      })
    ).rejects.toThrow('GitHub resolveReviewThread mutation did not confirm thread resolution');
  });
});
