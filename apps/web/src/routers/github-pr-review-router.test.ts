/**
 * @jest-environment node
 */
import { TRPCError } from '@trpc/server';
import { createCallerFactory } from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';

const getGitHubUserAccessToken = jest.fn();

jest.mock('@/lib/integrations/platforms/github/user-token-client', () => ({
  getGitHubUserAccessToken: (...args: unknown[]) => getGitHubUserAccessToken(...args),
}));

// The retry wrapper invokes `createGitHubPrReviewOctokit(token)` to build the
// Octokit handed to the `call` callback. We mock the factory to capture the
// token and install per-token call/reject behavior, so we can assert that a
// 401 produced a rotate + retry without spinning up a real Octokit.
type OctokitMock = {
  __token: string;
  pulls: {
    merge: jest.Mock;
    createReview: jest.Mock;
    createReviewComment: jest.Mock;
    createReplyForReviewComment: jest.Mock;
    updateBranch: jest.Mock;
    listFiles: jest.Mock;
    get: jest.Mock;
  };
  git: { deleteRef: jest.Mock };
  request: jest.Mock;
};

const tokenOctokits = new Map<string, OctokitMock>();

function buildOctokit(token: string): OctokitMock {
  const existing = tokenOctokits.get(token);
  if (existing) return existing;
  const octokit: OctokitMock = {
    __token: token,
    pulls: {
      merge: jest.fn(),
      createReview: jest.fn(),
      createReviewComment: jest.fn(),
      createReplyForReviewComment: jest.fn(),
      updateBranch: jest.fn(),
      listFiles: jest.fn(),
      get: jest.fn(),
    },
    git: { deleteRef: jest.fn() },
    request: jest.fn(),
  };
  tokenOctokits.set(token, octokit);
  return octokit;
}

const SAME_REPO_ID = 101;
const OTHER_REPO_ID = 202;

type PrGetFixture = {
  headRef: string;
  headSha: string;
  headRepoId: number;
  baseRepoId: number;
};

function mockPrGet(octokit: OctokitMock, fixture: PrGetFixture) {
  octokit.pulls.get.mockResolvedValueOnce({
    data: {
      head: { ref: fixture.headRef, sha: fixture.headSha, repo: { id: fixture.headRepoId } },
      base: { ref: 'main', repo: { id: fixture.baseRepoId } },
    },
  });
}

jest.mock('@/lib/github-pr-review/client', () => ({
  createGitHubPrReviewOctokit: (token: string) => buildOctokit(token),
  GITHUB_API_BASE_URL: 'https://api.github.com',
}));

let createCaller: any;

beforeAll(async () => {
  const mod = await import('./github-pr-review-router');
  createCaller = createCallerFactory(mod.githubPrReviewRouter);
});

function connected(token: string, authorizationId: string, credentialVersion: number) {
  return {
    status: 'connected' as const,
    credential: {
      token,
      expiresAtEpochMs: Date.now() + 3_600_000,
      githubLogin: 'octocat',
      authorizationId,
      credentialVersion,
    },
  };
}

const baseMergeInput = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  method: 'squash' as const,
  deleteBranch: true,
  expectedHeadSha: 'a'.repeat(40),
  headRef: 'feature/x',
  isCrossRepo: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  tokenOctokits.clear();
  getGitHubUserAccessToken.mockReset();
});

describe('githubPrReviewRouter.mergePullRequest', () => {
  it('skips the branch delete for a cross-repo head even when deleteBranch=true', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const firstOctokit = buildOctokit('t1');
    // The server now derives same-repo from the fetched PR; this test
    // exercises the legacy `isCrossRepo: true` path which the server must
    // ignore in favor of its derived value. We make the fetched PR same-repo
    // and the `isCrossRepo: true` claim must NOT prevent the delete (see
    // the "legacy fields are accepted and ignored" test). To keep this
    // test's intent intact, we make the fetched PR cross-repo here.
    mockPrGet(firstOctokit, {
      headRef: 'feature/x',
      headSha: 'a'.repeat(40),
      headRepoId: OTHER_REPO_ID,
      baseRepoId: SAME_REPO_ID,
    });
    firstOctokit.pulls.merge.mockResolvedValueOnce({
      data: { merged: true, sha: 'mergedsha', message: 'PR merged' },
    });

    const result = await caller.mergePullRequest({ ...baseMergeInput, isCrossRepo: true });

    expect(result).toEqual({ merged: true, sha: 'mergedsha', branchDeleted: false });
    expect(firstOctokit.pulls.get).toHaveBeenCalledTimes(1);
    expect(firstOctokit.pulls.merge).toHaveBeenCalledTimes(1);
    expect(firstOctokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it('skips the branch delete when deleteBranch=false', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const firstOctokit = buildOctokit('t1');
    mockPrGet(firstOctokit, {
      headRef: 'feature/x',
      headSha: 'a'.repeat(40),
      headRepoId: SAME_REPO_ID,
      baseRepoId: SAME_REPO_ID,
    });
    firstOctokit.pulls.merge.mockResolvedValueOnce({
      data: { merged: true, sha: 'mergedsha', message: 'PR merged' },
    });

    const result = await caller.mergePullRequest({ ...baseMergeInput, deleteBranch: false });

    expect(result).toEqual({ merged: true, sha: 'mergedsha', branchDeleted: false });
    expect(firstOctokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it('reports merged:false and skips branch delete when GitHub declines the merge', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const firstOctokit = buildOctokit('t1');
    mockPrGet(firstOctokit, {
      headRef: 'feature/x',
      headSha: 'a'.repeat(40),
      headRepoId: SAME_REPO_ID,
      baseRepoId: SAME_REPO_ID,
    });
    firstOctokit.pulls.merge.mockResolvedValueOnce({
      data: { merged: false, sha: 'mergedsha', message: 'PR is not mergeable' },
    });

    const result = await caller.mergePullRequest({ ...baseMergeInput, deleteBranch: true });

    expect(result).toEqual({ merged: false, sha: 'mergedsha', branchDeleted: false });
    expect(firstOctokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it('reports branchDeleted=true on a successful same-repo delete', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const firstOctokit = buildOctokit('t1');
    mockPrGet(firstOctokit, {
      headRef: 'feature/x',
      headSha: 'a'.repeat(40),
      headRepoId: SAME_REPO_ID,
      baseRepoId: SAME_REPO_ID,
    });
    firstOctokit.pulls.merge.mockResolvedValueOnce({
      data: { merged: true, sha: 'mergedsha', message: 'PR merged' },
    });
    firstOctokit.git.deleteRef.mockResolvedValueOnce({ data: {} });

    const result = await caller.mergePullRequest({ ...baseMergeInput, isCrossRepo: false });

    expect(result).toEqual({ merged: true, sha: 'mergedsha', branchDeleted: true });
    expect(firstOctokit.git.deleteRef).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      ref: 'heads/feature/x',
    });
  });

  it('reports branchDeleteError but does not throw when deleteRef fails', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const firstOctokit = buildOctokit('t1');
    mockPrGet(firstOctokit, {
      headRef: 'feature/x',
      headSha: 'a'.repeat(40),
      headRepoId: SAME_REPO_ID,
      baseRepoId: SAME_REPO_ID,
    });
    firstOctokit.pulls.merge.mockResolvedValueOnce({
      data: { merged: true, sha: 'mergedsha', message: 'PR merged' },
    });
    firstOctokit.git.deleteRef.mockRejectedValueOnce(
      Object.assign(new Error('Reference does not exist'), { status: 422 })
    );

    const result = await caller.mergePullRequest({ ...baseMergeInput, isCrossRepo: false });

    expect(result.merged).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(typeof result.branchDeleteError).toBe('string');
  });
});

describe('githubPrReviewRouter.mergePullRequest P0-D-09 (spoofed headRef + cross-repo + sha fence)', () => {
  // P0-D-09: a caller can no longer pick which ref gets deleted by sending
  // a spoofed `headRef` (e.g. "main"). The server derives the head ref,
  // same-repo identity, and head sha from `octokit.pulls.get` and fences
  // `git.deleteRef` on those server-derived values. The legacy
  // `headRef` / `isCrossRepo` fields are still accepted on the wire for
  // backward compatibility with older shipped clients but have no effect.

  it('deletes the server-derived head ref and ignores a spoofed headRef in the payload', async () => {
    // Baseline-demonstrating assertion: pre-fix, the `headRef: "main"` we
    // send here would have been passed verbatim to `git.deleteRef` and
    // the default branch would have been deleted. Post-fix, the only ref
    // touched is the server-derived `heads/feature/x`.
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const firstOctokit = buildOctokit('t1');
    mockPrGet(firstOctokit, {
      headRef: 'feature/x',
      headSha: 'a'.repeat(40),
      headRepoId: SAME_REPO_ID,
      baseRepoId: SAME_REPO_ID,
    });
    firstOctokit.pulls.merge.mockResolvedValueOnce({
      data: { merged: true, sha: 'mergedsha', message: 'PR merged' },
    });
    firstOctokit.git.deleteRef.mockResolvedValueOnce({ data: {} });

    const result = await caller.mergePullRequest({
      ...baseMergeInput,
      headRef: 'main', // spoofed — must be ignored
    });

    expect(result).toEqual({ merged: true, sha: 'mergedsha', branchDeleted: true });
    expect(firstOctokit.git.deleteRef).toHaveBeenCalledTimes(1);
    expect(firstOctokit.git.deleteRef).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      ref: 'heads/feature/x',
    });
    // Baseline assertion: the spoofed `main` ref never reaches `deleteRef`.
    expect(firstOctokit.git.deleteRef).not.toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/main' })
    );
  });

  it('does not delete any ref when the fetched PR is cross-repo (head.repo.id !== base.repo.id)', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const firstOctokit = buildOctokit('t1');
    mockPrGet(firstOctokit, {
      headRef: 'feature/fork-branch',
      headSha: 'a'.repeat(40),
      headRepoId: OTHER_REPO_ID,
      baseRepoId: SAME_REPO_ID,
    });
    firstOctokit.pulls.merge.mockResolvedValueOnce({
      data: { merged: true, sha: 'mergedsha', message: 'PR merged' },
    });

    const result = await caller.mergePullRequest({ ...baseMergeInput, isCrossRepo: false });

    expect(result).toEqual({ merged: true, sha: 'mergedsha', branchDeleted: false });
    expect(firstOctokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it('does not delete when the fetched head sha does not match expectedHeadSha', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const firstOctokit = buildOctokit('t1');
    // The PR's real head sha moved since the caller rendered the merge
    // sheet; the caller's `expectedHeadSha` is stale.
    mockPrGet(firstOctokit, {
      headRef: 'feature/x',
      headSha: 'b'.repeat(40),
      headRepoId: SAME_REPO_ID,
      baseRepoId: SAME_REPO_ID,
    });
    firstOctokit.pulls.merge.mockResolvedValueOnce({
      data: { merged: true, sha: 'mergedsha', message: 'PR merged' },
    });

    const result = await caller.mergePullRequest({ ...baseMergeInput });

    expect(result).toEqual({ merged: true, sha: 'mergedsha', branchDeleted: false });
    expect(firstOctokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it('still accepts a request that includes legacy headRef + isCrossRepo (no rejection)', async () => {
    // The schema must TOLERATE the legacy wire fields (older shipped
    // clients still send them). Even when the caller sends
    // `isCrossRepo: true`, the server derives same-repo from the fetched
    // PR and proceeds to delete when the PR is actually same-repo.
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const firstOctokit = buildOctokit('t1');
    mockPrGet(firstOctokit, {
      headRef: 'feature/x',
      headSha: 'a'.repeat(40),
      headRepoId: SAME_REPO_ID,
      baseRepoId: SAME_REPO_ID,
    });
    firstOctokit.pulls.merge.mockResolvedValueOnce({
      data: { merged: true, sha: 'mergedsha', message: 'PR merged' },
    });
    firstOctokit.git.deleteRef.mockResolvedValueOnce({ data: {} });

    const result = await caller.mergePullRequest({
      ...baseMergeInput,
      headRef: 'feature/x',
      isCrossRepo: true, // legacy lie — must be ignored
    });

    // The server-derived same-repo identity wins; the delete proceeds on
    // the server-derived head ref.
    expect(result).toEqual({ merged: true, sha: 'mergedsha', branchDeleted: true });
    expect(firstOctokit.git.deleteRef).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      ref: 'heads/feature/x',
    });
  });

  it('accepts a request that OMITS the legacy headRef + isCrossRepo fields entirely (new wire)', async () => {
    // The new mobile wire drops `headRef` / `isCrossRepo` entirely. The
    // schema must accept the request and derive everything from the
    // fetched PR.
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const firstOctokit = buildOctokit('t1');
    mockPrGet(firstOctokit, {
      headRef: 'feature/x',
      headSha: 'a'.repeat(40),
      headRepoId: SAME_REPO_ID,
      baseRepoId: SAME_REPO_ID,
    });
    firstOctokit.pulls.merge.mockResolvedValueOnce({
      data: { merged: true, sha: 'mergedsha', message: 'PR merged' },
    });
    firstOctokit.git.deleteRef.mockResolvedValueOnce({ data: {} });

    // Strip the legacy fields.
    const { headRef: _legacyHeadRef, isCrossRepo: _legacyIsCrossRepo, ...newWire } = baseMergeInput;
    void _legacyHeadRef;
    void _legacyIsCrossRepo;

    const result = await caller.mergePullRequest(newWire);

    expect(result).toEqual({ merged: true, sha: 'mergedsha', branchDeleted: true });
    expect(firstOctokit.git.deleteRef).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      ref: 'heads/feature/x',
    });
  });
});

describe('githubPrReviewRouter infinite-query inputs accept the tRPC direction field', () => {
  // tRPC's useInfiniteQuery integration injects `direction: 'forward'|'backward'`
  // into the procedure input. The inputs are `.strict()`, so without an explicit
  // `direction` field every page 400s (only reproducible end-to-end, since the
  // mobile client — not these unit callers — is what sends `direction`).
  it('listFiles accepts direction: "forward" and returns the page', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    buildOctokit('t1').pulls.listFiles.mockResolvedValueOnce({ data: [] });

    await expect(
      caller.listFiles({ owner: 'octocat', repo: 'hello', number: 1, direction: 'forward' })
    ).resolves.toMatchObject({ files: [] });
  });

  it('listReviewThreads accepts direction: "forward"', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    // First page issues PrReviewThreads + PrReviewConversationComments in parallel.
    buildOctokit('t1').request.mockImplementation(
      async (_path: string, body: { query: string }) => {
        if (body.query.includes('PrReviewConversationComments')) {
          return {
            data: {
              data: {
                repository: {
                  pullRequest: {
                    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  },
                },
              },
            },
          };
        }
        return {
          data: {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          },
        };
      }
    );

    await expect(
      caller.listReviewThreads({ owner: 'octocat', repo: 'hello', number: 1, direction: 'forward' })
    ).resolves.toMatchObject({ threads: [], conversation: [], nextCursor: null });
  });

  it('listReviewThreads maps reactionGroups to non-zero DTO reactions only', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    buildOctokit('t1').request.mockImplementation(
      async (_path: string, body: { query: string }) => {
        if (body.query.includes('PrReviewConversationComments')) {
          return {
            data: {
              data: {
                repository: {
                  pullRequest: {
                    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  },
                },
              },
            },
          };
        }
        return {
          data: {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: 'PRRT_1',
                        isResolved: false,
                        isOutdated: false,
                        subjectType: 'LINE',
                        path: 'src/foo.ts',
                        line: 4,
                        startLine: null,
                        originalLine: 4,
                        originalStartLine: null,
                        diffSide: 'RIGHT',
                        comments: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [
                            {
                              databaseId: 11,
                              id: 'PRRC_11',
                              body: 'nit',
                              createdAt: '2024-01-01T00:00:00Z',
                              author: { login: 'octocat', avatarUrl: 'https://x/y.png' },
                              // Live schema: all group types present; zero-count filtered out.
                              reactionGroups: [
                                {
                                  content: 'THUMBS_UP',
                                  viewerHasReacted: true,
                                  reactors: { totalCount: 2 },
                                },
                                {
                                  content: 'THUMBS_DOWN',
                                  viewerHasReacted: false,
                                  reactors: { totalCount: 0 },
                                },
                                {
                                  content: 'LAUGH',
                                  viewerHasReacted: false,
                                  reactors: { totalCount: 0 },
                                },
                                {
                                  content: 'HOORAY',
                                  viewerHasReacted: false,
                                  reactors: { totalCount: 0 },
                                },
                                {
                                  content: 'CONFUSED',
                                  viewerHasReacted: false,
                                  reactors: { totalCount: 0 },
                                },
                                {
                                  content: 'HEART',
                                  viewerHasReacted: false,
                                  reactors: { totalCount: 1 },
                                },
                                {
                                  content: 'ROCKET',
                                  viewerHasReacted: false,
                                  reactors: { totalCount: 0 },
                                },
                                {
                                  content: 'EYES',
                                  viewerHasReacted: false,
                                  reactors: { totalCount: 0 },
                                },
                              ],
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
    );

    const result = await caller.listReviewThreads({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      direction: 'forward',
    });

    expect(result.threads).toHaveLength(1);
    expect(result.conversation).toEqual([]);
    expect(result.threads[0]?.comments[0]?.reactions).toEqual([
      { content: 'THUMBS_UP', count: 2, viewerHasReacted: true },
      { content: 'HEART', count: 1, viewerHasReacted: false },
    ]);
  });

  it('listReviewThreads maps first-comment diffHunk onto the thread DTO', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    buildOctokit('t1').request.mockImplementation(
      async (_path: string, body: { query: string }) => {
        if (body.query.includes('PrReviewConversationComments')) {
          return {
            data: {
              data: {
                repository: {
                  pullRequest: {
                    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  },
                },
              },
            },
          };
        }
        return {
          data: {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: 'PRRT_with_hunk',
                        isResolved: false,
                        isOutdated: false,
                        subjectType: 'LINE',
                        path: 'src/foo.ts',
                        line: 4,
                        startLine: null,
                        originalLine: 4,
                        originalStartLine: null,
                        diffSide: 'RIGHT',
                        comments: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [
                            {
                              databaseId: 21,
                              id: 'PRRC_21',
                              body: 'nit',
                              diffHunk: '@@ -1,2 +1,3 @@\n+added',
                              createdAt: '2024-01-01T00:00:00Z',
                              author: { login: 'octocat', avatarUrl: 'https://x/y.png' },
                              reactionGroups: [],
                            },
                          ],
                        },
                      },
                      {
                        id: 'PRRT_no_comments',
                        isResolved: false,
                        isOutdated: false,
                        subjectType: 'LINE',
                        path: 'src/bar.ts',
                        line: 1,
                        startLine: null,
                        originalLine: 1,
                        originalStartLine: null,
                        diffSide: 'RIGHT',
                        comments: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [],
                        },
                      },
                      {
                        id: 'PRRT_no_hunk',
                        isResolved: false,
                        isOutdated: false,
                        subjectType: 'LINE',
                        path: 'src/baz.ts',
                        line: 2,
                        startLine: null,
                        originalLine: 2,
                        originalStartLine: null,
                        diffSide: 'RIGHT',
                        comments: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [
                            {
                              databaseId: 22,
                              id: 'PRRC_22',
                              body: 'no hunk',
                              createdAt: '2024-01-01T00:00:00Z',
                              author: { login: 'octocat', avatarUrl: 'https://x/y.png' },
                              reactionGroups: [],
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
    );

    const result = await caller.listReviewThreads({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      direction: 'forward',
    });

    expect(result.threads).toHaveLength(3);
    expect(result.threads[0]?.diffHunk).toBe('@@ -1,2 +1,3 @@\n+added');
    expect(result.threads[1]?.diffHunk).toBeNull();
    expect(result.threads[2]?.diffHunk).toBeNull();
  });
});

describe('githubPrReviewRouter.listReviewThreads conversation comments', () => {
  const emptyThreads = {
    nodes: [] as unknown[],
    pageInfo: { hasNextPage: false, endCursor: null as string | null },
  };

  function conversationNode(overrides: {
    databaseId: number;
    id: string;
    body: string;
    createdAt?: string;
  }) {
    return {
      databaseId: overrides.databaseId,
      id: overrides.id,
      body: overrides.body,
      createdAt: overrides.createdAt ?? '2026-01-01T00:00:00Z',
      author: { login: 'alice', avatarUrl: 'https://avatars.example/alice' },
      reactionGroups: [
        { content: 'THUMBS_UP', viewerHasReacted: false, reactors: { totalCount: 1 } },
        { content: 'HEART', viewerHasReacted: false, reactors: { totalCount: 0 } },
      ],
    };
  }

  function mockGraphqlByOperation(
    octokit: OctokitMock,
    handlers: {
      threads?: (vars: Record<string, unknown>) => unknown;
      conversation?: (vars: Record<string, unknown>) => unknown;
    }
  ) {
    octokit.request.mockImplementation(
      async (_path: string, body: { query: string; variables: Record<string, unknown> }) => {
        if (body.query.includes('query PrReviewConversationComments')) {
          const payload = handlers.conversation?.(body.variables) ?? {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          };
          return {
            data: {
              data: { repository: { pullRequest: { comments: payload } } },
            },
          };
        }
        if (body.query.includes('query PrReviewThreads')) {
          const payload = handlers.threads?.(body.variables) ?? emptyThreads;
          return {
            data: {
              data: { repository: { pullRequest: { reviewThreads: payload } } },
            },
          };
        }
        throw new Error(`unexpected GraphQL operation: ${body.query.slice(0, 80)}`);
      }
    );
  }

  it('returns mapped conversation comments on the first page', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    mockGraphqlByOperation(buildOctokit('t1'), {
      conversation: () => ({
        nodes: [conversationNode({ databaseId: 42, id: 'IC_42', body: 'top-level' })],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const result = await caller.listReviewThreads({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
    });

    expect(result.conversation).toEqual([
      {
        commentId: 42,
        nodeId: 'IC_42',
        author: { login: 'alice', avatarUrl: 'https://avatars.example/alice' },
        bodyMarkdown: 'top-level',
        createdAt: '2026-01-01T00:00:00Z',
        reactions: [{ content: 'THUMBS_UP', count: 1, viewerHasReacted: false }],
      },
    ]);
    expect(result.threads).toEqual([]);
  });

  it('returns conversation: [] when the PR has no conversation comments', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    mockGraphqlByOperation(buildOctokit('t1'), {
      conversation: () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const result = await caller.listReviewThreads({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
    });

    expect(result.conversation).toEqual([]);
  });

  it('paginates conversation comments to completion across multiple pages', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    let conversationCalls = 0;
    mockGraphqlByOperation(buildOctokit('t1'), {
      conversation: vars => {
        conversationCalls += 1;
        if (vars.after == null) {
          return {
            nodes: [conversationNode({ databaseId: 1, id: 'IC_1', body: 'page-1' })],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          };
        }
        if (vars.after === 'cursor-1') {
          return {
            nodes: [conversationNode({ databaseId: 2, id: 'IC_2', body: 'page-2' })],
            pageInfo: { hasNextPage: false, endCursor: 'cursor-2' },
          };
        }
        throw new Error(`unexpected after cursor: ${String(vars.after)}`);
      },
    });

    const result = await caller.listReviewThreads({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
    });

    expect(conversationCalls).toBe(2);
    expect(result.conversation.map((c: { commentId: number }) => c.commentId)).toEqual([1, 2]);
  });

  it('truncates conversation comments after CONVERSATION_COMMENTS_MAX_PAGES', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    let conversationCalls = 0;
    mockGraphqlByOperation(buildOctokit('t1'), {
      conversation: () => {
        conversationCalls += 1;
        // Always report another page so the loop hits the hard cap.
        const pageIndex = conversationCalls;
        return {
          nodes: [
            conversationNode({
              databaseId: pageIndex,
              id: `IC_${pageIndex}`,
              body: `page-${pageIndex}`,
            }),
          ],
          pageInfo: {
            hasNextPage: true,
            endCursor: `cursor-${pageIndex}`,
          },
        };
      },
    });

    const result = await caller.listReviewThreads({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
    });

    // Cap is 5 pages (CONVERSATION_COMMENTS_MAX_PAGES); further pages are dropped.
    expect(conversationCalls).toBe(5);
    expect(result.conversation).toHaveLength(5);
    expect(result.conversation.map((c: { commentId: number }) => c.commentId)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('returns conversation: [] on a cursored page and does not issue PrReviewConversationComments', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const octokit = buildOctokit('t1');
    let conversationCalls = 0;
    mockGraphqlByOperation(octokit, {
      conversation: () => {
        conversationCalls += 1;
        return {
          nodes: [conversationNode({ databaseId: 99, id: 'IC_99', body: 'should-not-fetch' })],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      },
      threads: () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const result = await caller.listReviewThreads({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      cursor: 'Y3Vyc29yOnYyOpHOAAAAAA==',
    });

    expect(result.conversation).toEqual([]);
    expect(conversationCalls).toBe(0);
    const queries = octokit.request.mock.calls.map(
      (call: unknown[]) => (call[1] as { query: string }).query
    );
    expect(queries.some((q: string) => q.includes('PrReviewConversationComments'))).toBe(false);
    expect(queries.some((q: string) => q.includes('PrReviewThreads'))).toBe(true);
  });

  it('null-connection return shape includes conversation: [] via the builder', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const octokit = buildOctokit('t1');
    // Null pullRequest on PrReviewThreads → early null-connection path through the builder.
    octokit.request.mockImplementation(async (_path: string, body: { query: string }) => {
      if (body.query.includes('query PrReviewConversationComments')) {
        return {
          data: {
            data: {
              repository: {
                pullRequest: {
                  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          },
        };
      }
      if (body.query.includes('query PrReviewThreads')) {
        return {
          data: {
            data: { repository: { pullRequest: null } },
          },
        };
      }
      throw new Error(`unexpected GraphQL operation: ${body.query.slice(0, 80)}`);
    });

    const result = await caller.listReviewThreads({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
    });

    expect(result).toEqual({ threads: [], conversation: [], nextCursor: null });
  });
});

describe('githubPrReviewRouter mutations go through withGitHubUserTokenRetry', () => {
  it('rotates the credential and retries on a raw 401', async () => {
    getGitHubUserAccessToken
      .mockResolvedValueOnce(connected('t1', 'auth_1', 1))
      .mockResolvedValueOnce(connected('t2', 'auth_1', 2));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    // Pre-create the two octokits the wrapper will hand to the call callback.
    const t1Octokit = buildOctokit('t1');
    const t2Octokit = buildOctokit('t2');
    t1Octokit.pulls.createReviewComment.mockRejectedValueOnce({ status: 401, message: 'gone' });
    t2Octokit.pulls.createReviewComment.mockResolvedValueOnce({
      data: { id: 77, node_id: 'N_77' },
    });

    const result = await caller.createReviewComment({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      body: 'hi',
      path: 'src/foo.ts',
      line: 4,
      side: 'RIGHT',
      commitSha: '0'.repeat(40),
    });

    expect(result).toEqual({ commentId: 77, nodeId: 'N_77' });
    expect(t1Octokit.pulls.createReviewComment).toHaveBeenCalledTimes(1);
    expect(t2Octokit.pulls.createReviewComment).toHaveBeenCalledTimes(1);
    // The second call uses the rotated token's octokit, confirming the rotate.
    expect(t2Octokit.__token).toBe('t2');
  });

  it('classifies a non-401 raw error as CONFLICT (e.g. 409 stale head)', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const t1Octokit = buildOctokit('t1');
    // The server now fetches the PR first to derive head ref / same-repo /
    // head sha; the actual merge call is the one that 409s here.
    mockPrGet(t1Octokit, {
      headRef: 'feature/x',
      headSha: 'a'.repeat(40),
      headRepoId: SAME_REPO_ID,
      baseRepoId: SAME_REPO_ID,
    });
    t1Octokit.pulls.merge.mockRejectedValueOnce({
      status: 409,
      message: 'Head branch was modified',
    });

    await expect(
      caller.mergePullRequest({ ...baseMergeInput, isCrossRepo: true })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Only the initial fetch — no rotate, since the error was not 401.
    expect(getGitHubUserAccessToken).toHaveBeenCalledTimes(1);
  });
});

// `submitReview` is a representative batch mutation — a quick smoke test that
// the comments[] payload is forwarded verbatim, complementing the builder
// unit tests.
describe('githubPrReviewRouter.submitReview', () => {
  it('forwards the comments[] payload to pulls.createReview', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.createReview.mockResolvedValueOnce({
      data: { id: 99, node_id: 'N_99', state: 'PENDING' },
    });

    const result = await caller.submitReview({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      event: 'REQUEST_CHANGES',
      body: 'see comments',
      commitSha: '0'.repeat(40),
      comments: [{ path: 'src/foo.ts', line: 5, side: 'RIGHT', body: 'fix me' }],
    });

    expect(result).toEqual({ reviewId: 99, nodeId: 'N_99', state: 'PENDING' });
    expect(t1Octokit.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'REQUEST_CHANGES',
        commit_id: '0'.repeat(40),
        comments: [
          expect.objectContaining({ path: 'src/foo.ts', line: 5, side: 'RIGHT', body: 'fix me' }),
        ],
      })
    );
  });
});

describe('githubPrReviewRouter GraphQL mutations', () => {
  it('resolveThread unwraps the { data: { data } } envelope and returns the operation result', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const t1Octokit = buildOctokit('t1');
    t1Octokit.request.mockResolvedValueOnce({
      data: { data: { resolveReviewThread: { thread: { id: 'THREAD_1', isResolved: true } } } },
    });

    const result = await caller.resolveThread({ threadId: 'THREAD_1' });

    expect(result).toEqual({ threadId: 'THREAD_1', isResolved: true });
  });

  it('throws when GitHub returns a null operation payload (no synthesized success)', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const t1Octokit = buildOctokit('t1');
    t1Octokit.request.mockResolvedValueOnce({
      data: { data: { resolveReviewThread: null } },
    });

    await expect(caller.resolveThread({ threadId: 'THREAD_1' })).rejects.toMatchObject({
      code: 'BAD_GATEWAY',
    });
  });

  it('classifies a GraphQL errors[] entry (FORBIDDEN) instead of reporting success', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const t1Octokit = buildOctokit('t1');
    t1Octokit.request.mockResolvedValueOnce({
      data: { data: null, errors: [{ type: 'FORBIDDEN', message: 'no push access' }] },
    });

    await expect(caller.resolveThread({ threadId: 'THREAD_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('addReaction returns the confirmed content from the GraphQL payload', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const t1Octokit = buildOctokit('t1');
    t1Octokit.request.mockResolvedValueOnce({
      data: { data: { addReaction: { reaction: { content: 'HEART' } } } },
    });

    const result = await caller.addReaction({ commentNodeId: 'C_1', content: 'HEART' });
    expect(result).toEqual({ content: 'HEART' });
  });
});

// Touch the TRPCError import so the linter doesn't strip it (the retry
// wrapper surfaces already-classified TRPCError unchanged).
void TRPCError;
