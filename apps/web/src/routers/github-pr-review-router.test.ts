/**
 * @jest-environment node
 */
import { TRPCError } from '@trpc/server';
import { createCallerFactory } from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';
import { prLedgerResourceKey } from './github-pr-review-router';

const getGitHubUserAccessToken = jest.fn();

jest.mock('@/lib/integrations/platforms/github/user-token-client', () => ({
  getGitHubUserAccessToken: (...args: unknown[]) => getGitHubUserAccessToken(...args),
}));

// P1-A-08c: the PR operation ledger. The router admits / settles /
// marks-reconcile-pending through `@kilocode/db/operation-ledger`. Both it and
// `@/lib/drizzle` are mocked so the ledger tests can assert admission, settle,
// replay, and reconcile orchestration without a database. The analytics
// identity comes from `ctx.user`, which carries no email here, so it falls
// back to the user id.
const mockAdmitOperation = jest.fn();
const mockSettleOperation = jest.fn();
const mockMarkReconcilePending = jest.fn();
const mockRecordOperationAcceptance = jest.fn();

jest.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: (...args: unknown[]) => mockAdmitOperation(...args),
  settleOperation: (...args: unknown[]) => mockSettleOperation(...args),
  markReconcilePending: (...args: unknown[]) => mockMarkReconcilePending(...args),
  recordOperationAcceptance: (...args: unknown[]) => mockRecordOperationAcceptance(...args),
}));

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  },
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
    getReviewComment: jest.Mock;
    getReview: jest.Mock;
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
      getReviewComment: jest.fn(),
      getReview: jest.fn(),
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

// ----- P1-A-08c: PR operation ledger --------------------------------------
//
// With an `operationKey`, the four PR mutations admit a `pr`-domain ledger
// row, run the GitHub effect only after admission, and dedupe / replay /
// reconcile same-key retries. These tests drive the router through the
// mocked ledger helpers and assert admission payloads, settle outcomes,
// CONFLICT markers, replay markers, reconcile decisions, and the
// `pr_operation_settled` outbox payload (no free text, no resource keys).

const PR_AMBIGUOUS_MESSAGE = "Couldn't confirm — check the PR before retrying.";
const PR_REPLAY_FAILED_MESSAGE = 'This action did not complete. Please try again.';
const PR_CONFLICT_MESSAGE = 'GitHub reported a conflict for this PR';
const OPERATION_IN_PROGRESS_MESSAGE = 'operation_in_progress';
const OPERATION_KEY_REUSE_MISMATCH_MESSAGE = 'operation_key_reuse_mismatch';
const PR_LEDGER_SETTLE_FAILED_MESSAGE =
  'The action completed, but we could not record the result. Please try again.';
const PR_LEDGER_PERSISTENCE_FAILED_MESSAGE =
  'We could not record this action. Please try again later.';

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ledger-row-1',
    status: 'admitted',
    canonical_result: null,
    intent: 'create_review_comment',
    resource_key: commentResourceKey,
    ...overrides,
  };
}

const ledgerCommentInput = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  body: 'ledger comment body',
  path: 'src/foo.ts',
  line: 4,
  side: 'RIGHT',
  commitSha: '0'.repeat(40),
  operationKey: 'key-comment-1',
};

const ledgerMergeInput = {
  ...baseMergeInput,
  operationKey: 'key-merge-1',
};

// The stored ledger identity embeds the deterministic request fingerprint;
// tests build the exact value so the post-admission row comparison matches.
const commentResourceKey = prLedgerResourceKey('create_review_comment', ledgerCommentInput);
const mergeResourceKey = prLedgerResourceKey('merge', ledgerMergeInput);
const replyResourceKey = prLedgerResourceKey('reply_comment', {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  commentId: 5,
  body: 'thanks',
});
const reviewResourceKey = prLedgerResourceKey('submit_review', {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  event: 'APPROVE',
  body: 'lgtm!!!',
  commitSha: '0'.repeat(40),
  comments: [{ path: 'src/foo.ts', line: 5, side: 'RIGHT', body: 'fix me' }],
});

// The stored `resource_key` is the dedupe identity for up to 30 days. Every
// other ledger test builds both sides with `prLedgerResourceKey`, so a change
// to the fingerprint would pass unnoticed while rotating every in-flight key.
// Pin the exact values instead.
describe('prLedgerResourceKey', () => {
  it('is stable for the comment and merge intents', () => {
    expect(commentResourceKey).toBe('octocat/hello#1::12b5525f2df626e1');
    expect(mergeResourceKey).toBe('octocat/hello#1::bdce24cc30b1ecbf');
  });
});

describe('githubPrReviewRouter PR operation ledger (P1-A-08c)', () => {
  beforeEach(() => {
    mockAdmitOperation.mockReset();
    mockSettleOperation.mockReset();
    mockMarkReconcilePending.mockReset();
    mockRecordOperationAcceptance.mockReset();
    mockRecordOperationAcceptance.mockResolvedValue(ledgerRow());
    mockSettleOperation.mockResolvedValue({ settled: true });
    mockMarkReconcilePending.mockResolvedValue(ledgerRow({ status: 'reconcile_pending' }));
  });

  it('admits createReviewComment under domain pr and settles completed at the effect boundary', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({ admission: 'admitted', row: ledgerRow() });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.createReviewComment.mockResolvedValueOnce({
      data: { id: 42, node_id: 'N_42' },
    });

    const result = await caller.createReviewComment(ledgerCommentInput);

    expect(result).toEqual({ commentId: 42, nodeId: 'N_42' });
    expect(mockAdmitOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        domain: 'pr',
        intent: 'create_review_comment',
        operationKey: 'key-comment-1',
        resourceKey: commentResourceKey,
        taxonomy: 'reconcile-first',
        leaseSeconds: 120,
      })
    );
    expect(mockSettleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rowId: 'ledger-row-1',
        status: 'completed',
        outcomeCode: 'ok',
        canonicalResult: { commentId: 42, nodeId: 'N_42' },
      })
    );
    // The outbox event is the pr_operation_settled catalog schema with
    // enum-only properties: no free text, no resource key.
    const settleCall = mockSettleOperation.mock.calls[0][1] as {
      outboxEvent: { eventName: string; properties: Record<string, unknown> };
    };
    expect(settleCall.outboxEvent.eventName).toBe('pr_operation_settled');
    expect(settleCall.outboxEvent.properties).toEqual(
      expect.objectContaining({
        source: 'web',
        surface: 'pr',
        phase: 'terminal',
        intent: 'create_review_comment',
        outcome: 'completed',
        duration_ms: expect.any(Number),
      })
    );
    const serialized = JSON.stringify(settleCall.outboxEvent.properties);
    expect(serialized).not.toContain('octocat/hello#1');
    expect(serialized).not.toContain('ledger comment body');
  });

  it('admits and settles replyToComment with a commentId canonical result', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'admitted',
      row: ledgerRow({ intent: 'reply_comment', resource_key: replyResourceKey }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.createReplyForReviewComment.mockResolvedValueOnce({
      data: { id: 9, node_id: 'N_9' },
    });

    const result = await caller.replyToComment({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      commentId: 5,
      body: 'thanks',
      operationKey: 'key-reply-1',
    });

    expect(result).toEqual({ commentId: 9, nodeId: 'N_9' });
    expect(mockAdmitOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ intent: 'reply_comment', operationKey: 'key-reply-1' })
    );
    expect(mockSettleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'completed',
        canonicalResult: { commentId: 9, nodeId: 'N_9' },
      })
    );
  });

  it('admits and settles submitReview and keeps free text out of the canonical result', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'admitted',
      row: ledgerRow({ intent: 'submit_review', resource_key: reviewResourceKey }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.createReview.mockResolvedValueOnce({
      data: { id: 99, node_id: 'N_99', state: 'APPROVE' },
    });

    const result = await caller.submitReview({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      event: 'APPROVE',
      body: 'lgtm!!!',
      commitSha: '0'.repeat(40),
      comments: [{ path: 'src/foo.ts', line: 5, side: 'RIGHT', body: 'fix me' }],
      operationKey: 'key-review-1',
    });

    expect(result).toEqual({ reviewId: 99, nodeId: 'N_99', state: 'APPROVE' });
    expect(mockAdmitOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ intent: 'submit_review', operationKey: 'key-review-1' })
    );
    const settleCall = mockSettleOperation.mock.calls[0][1] as {
      canonicalResult: Record<string, unknown>;
      outboxEvent: { properties: Record<string, unknown> };
    };
    // Only opaque provider ids and the confirmed GitHub enum enter the
    // canonical result — the body and the inline comment text never do. The
    // `state` is carried so a replayed submitReview keeps the client's
    // required response shape.
    expect(settleCall.canonicalResult).toEqual({ reviewId: 99, nodeId: 'N_99', state: 'APPROVE' });
    const serialized = JSON.stringify({
      canonical: settleCall.canonicalResult,
      properties: settleCall.outboxEvent.properties,
    });
    expect(serialized).not.toContain('lgtm!!!');
    expect(serialized).not.toContain('fix me');
    expect(serialized).not.toContain('octocat/hello#1');
  });

  it('replays a settled submitReview with the state field the client requires', async () => {
    // The confirmed `state` lives in the canonical result, so a same-key
    // replay returns the exact response shape the client reads on first
    // execution (`{ reviewId, nodeId, state }`), not a state-less receipt.
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'duplicate_settled',
      row: ledgerRow({
        intent: 'submit_review',
        resource_key: reviewResourceKey,
        status: 'completed',
        canonical_result: { reviewId: 99, nodeId: 'N_99', state: 'APPROVE' },
      }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const result = await caller.submitReview({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      event: 'APPROVE',
      body: 'lgtm!!!',
      commitSha: '0'.repeat(40),
      comments: [{ path: 'src/foo.ts', line: 5, side: 'RIGHT', body: 'fix me' }],
      operationKey: 'key-review-1',
    });

    expect(result).toEqual({ reviewId: 99, nodeId: 'N_99', state: 'APPROVE', replayed: true });
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('returns CONFLICT operation_in_progress for a live same-key duplicate without touching GitHub', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'duplicate_in_flight',
      row: ledgerRow(),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: OPERATION_IN_PROGRESS_MESSAGE,
    });
    expect(t1Octokit.pulls.createReviewComment).not.toHaveBeenCalled();
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('replays the sanitized canonical result marked replayed on a same-key settled duplicate', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'duplicate_settled',
      row: ledgerRow({
        status: 'completed',
        canonical_result: { commentId: 7, nodeId: 'N_7' },
      }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');

    const result = await caller.createReviewComment(ledgerCommentInput);

    expect(result).toEqual({ commentId: 7, nodeId: 'N_7', replayed: true });
    expect(t1Octokit.pulls.createReviewComment).not.toHaveBeenCalled();
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('rejects a replayed settled-failed row as a non-retryable fresh-intent signal', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'duplicate_settled',
      row: ledgerRow({ status: 'failed' }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: PR_REPLAY_FAILED_MESSAGE,
    });
  });

  it('rejects cross-intent operation-key reuse with operation_key_reuse_mismatch (no effect, no replay)', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    // The key already exists but belongs to a DIFFERENT intent (a merge row
    // stored under the same operation key). The stored identity must never
    // replay or reconcile the comment request.
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'duplicate_settled',
      row: ledgerRow({ intent: 'merge', resource_key: mergeResourceKey }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: OPERATION_KEY_REUSE_MISMATCH_MESSAGE,
    });
    expect(t1Octokit.pulls.createReviewComment).not.toHaveBeenCalled();
    expect(mockSettleOperation).not.toHaveBeenCalled();
    expect(mockMarkReconcilePending).not.toHaveBeenCalled();
  });

  it('rejects operation-key reuse for a different request fingerprint under the same intent', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    // Same key, same intent, but the stored row was written for a DIFFERENT
    // request (the client changed an intent input without rotating). The
    // server must not replay the previous request's canonical result.
    const editedResourceKey = prLedgerResourceKey('create_review_comment', {
      ...ledgerCommentInput,
      body: 'edited body',
    });
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'duplicate_settled',
      row: ledgerRow({
        status: 'completed',
        canonical_result: { commentId: 7, nodeId: 'N_7' },
        resource_key: editedResourceKey,
      }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: OPERATION_KEY_REUSE_MISMATCH_MESSAGE,
    });
    expect(t1Octokit.pulls.createReviewComment).not.toHaveBeenCalled();
    expect(mockSettleOperation).not.toHaveBeenCalled();
    expect(mockMarkReconcilePending).not.toHaveBeenCalled();
  });

  it('settles a deterministic GitHub rejection as failed and rethrows the typed error', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({ admission: 'admitted', row: ledgerRow() });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.createReviewComment.mockRejectedValueOnce({
      status: 422,
      message: 'Line was not part of the diff',
    });

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockSettleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'failed',
        outcomeCode: 'bad_request',
        outboxEvent: expect.objectContaining({
          properties: expect.objectContaining({ outcome: 'failed' }),
        }),
      })
    );
    expect(mockMarkReconcilePending).not.toHaveBeenCalled();
  });

  it('marks an ambiguous 5xx outcome reconcile-pending and surfaces the ambiguous CONFLICT', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({ admission: 'admitted', row: ledgerRow() });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.createReviewComment.mockRejectedValueOnce({
      status: 503,
      message: 'Service unavailable',
    });

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: PR_AMBIGUOUS_MESSAGE,
    });
    expect(mockMarkReconcilePending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rowId: 'ledger-row-1',
        outboxEvent: expect.objectContaining({
          eventName: 'pr_operation_settled',
          properties: expect.objectContaining({
            intent: 'create_review_comment',
            outcome: 'ambiguous',
            reconcile_result: 'unresolved',
          }),
        }),
      })
    );
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('marks an ambiguous network/timeout failure reconcile-pending (no status on the raw error)', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({ admission: 'admitted', row: ledgerRow() });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.createReviewComment.mockRejectedValueOnce(new Error('socket hang up'));

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: PR_AMBIGUOUS_MESSAGE,
    });
    expect(mockMarkReconcilePending).toHaveBeenCalledTimes(1);
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('never re-executes an unresolved same-key retry when no provider reference was recorded', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    // Takeover: the admitted lease expired but the write response was never
    // persisted, so no provider reference exists to reconcile against.
    mockAdmitOperation.mockResolvedValueOnce({ admission: 'takeover', row: ledgerRow() });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: PR_AMBIGUOUS_MESSAGE,
    });
    expect(t1Octokit.pulls.createReviewComment).not.toHaveBeenCalled();
    // The unresolved takeover marks the row reconcile-pending (never settles
    // it) so the reconciliation lease is immediately claimable and the
    // ambiguous outbox event is recorded exactly once.
    expect(mockMarkReconcilePending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rowId: 'ledger-row-1',
        outboxEvent: expect.objectContaining({
          eventName: 'pr_operation_settled',
          properties: expect.objectContaining({
            intent: 'create_review_comment',
            outcome: 'ambiguous',
            reconcile_result: 'unresolved',
          }),
        }),
      })
    );
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('reconciles a same-key retry by re-reading the recorded provider reference and replays it', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: ledgerRow({
        status: 'reconcile_pending',
        canonical_result: { commentId: 42, nodeId: 'N_42' },
      }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.getReviewComment.mockResolvedValueOnce({
      data: { id: 42, node_id: 'N_42' },
    });

    const result = await caller.createReviewComment(ledgerCommentInput);

    expect(result).toEqual({ commentId: 42, nodeId: 'N_42', replayed: true });
    expect(t1Octokit.pulls.createReviewComment).not.toHaveBeenCalled();
    expect(mockSettleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'completed',
        outcomeCode: 'ok',
        canonicalResult: { commentId: 42, nodeId: 'N_42' },
        outboxEvent: expect.objectContaining({
          properties: expect.objectContaining({
            outcome: 'completed',
            reconcile_result: 'confirmed_completed',
          }),
        }),
      })
    );
  });

  it('settles failed as confirmed_absent when the recorded provider reference is gone', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: ledgerRow({
        status: 'reconcile_pending',
        canonical_result: { commentId: 42, nodeId: 'N_42' },
      }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.getReviewComment.mockRejectedValueOnce({ status: 404, message: 'gone' });

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: PR_AMBIGUOUS_MESSAGE,
    });
    expect(mockSettleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'failed',
        outcomeCode: 'effect_absent',
        outboxEvent: expect.objectContaining({
          properties: expect.objectContaining({
            outcome: 'failed',
            reconcile_result: 'confirmed_absent',
          }),
        }),
      })
    );
    expect(t1Octokit.pulls.createReviewComment).not.toHaveBeenCalled();
  });

  it('reconciles a same-key merge retry to completed when the PR is merged', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: ledgerRow({
        status: 'reconcile_pending',
        intent: 'merge',
        resource_key: mergeResourceKey,
      }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.get.mockResolvedValueOnce({
      data: {
        state: 'closed',
        merged: true,
        merge_commit_sha: 'm1',
        head: { ref: 'feature/x', sha: 'a'.repeat(40) },
      },
    });

    const result = await caller.mergePullRequest(ledgerMergeInput);

    expect(result).toEqual({ merged: true, sha: 'm1', branchDeleted: false, replayed: true });
    expect(t1Octokit.pulls.merge).not.toHaveBeenCalled();
    expect(mockSettleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'completed',
        canonicalResult: { merged: true, sha: 'm1', branchDeleted: false },
        outboxEvent: expect.objectContaining({
          properties: expect.objectContaining({
            intent: 'merge',
            outcome: 'completed',
            reconcile_result: 'confirmed_completed',
          }),
        }),
      })
    );
  });

  it('reconciles a same-key merge retry to failed/absent when the PR closed without merging', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: ledgerRow({
        status: 'reconcile_pending',
        intent: 'merge',
        resource_key: mergeResourceKey,
      }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.get.mockResolvedValueOnce({
      data: { state: 'closed', merged: false },
    });

    await expect(caller.mergePullRequest(ledgerMergeInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: PR_CONFLICT_MESSAGE,
    });
    expect(mockSettleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed', outcomeCode: 'already_closed' })
    );
    expect(t1Octokit.pulls.merge).not.toHaveBeenCalled();
  });

  it('reconciles a same-key merge retry to failed/absent when the expected head moved', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: ledgerRow({
        status: 'reconcile_pending',
        intent: 'merge',
        resource_key: mergeResourceKey,
      }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.get.mockResolvedValueOnce({
      data: { state: 'open', head: { ref: 'feature/x', sha: 'b'.repeat(40) } },
    });

    await expect(caller.mergePullRequest(ledgerMergeInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: PR_CONFLICT_MESSAGE,
    });
    expect(mockSettleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed', outcomeCode: 'head_moved' })
    );
    expect(t1Octokit.pulls.merge).not.toHaveBeenCalled();
  });

  it('re-executes the merge when the expected head lineage is intact (takeover)', async () => {
    // Two token fetches: one for the reconcile read, one for the re-executed merge.
    getGitHubUserAccessToken
      .mockResolvedValueOnce(connected('t1', 'auth_1', 1))
      .mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'takeover',
      row: ledgerRow({ intent: 'merge', resource_key: mergeResourceKey }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    const prFixture = {
      state: 'open',
      head: { ref: 'feature/x', sha: 'a'.repeat(40), repo: { id: SAME_REPO_ID } },
      base: { ref: 'main', repo: { id: SAME_REPO_ID } },
    };
    // One read for the reconcile, one read inside runMergeWrite.
    t1Octokit.pulls.get.mockResolvedValueOnce({ data: prFixture }).mockResolvedValueOnce({
      data: prFixture,
    });
    t1Octokit.pulls.merge.mockResolvedValueOnce({ data: { merged: true, sha: 'm1' } });
    t1Octokit.git.deleteRef.mockResolvedValueOnce({ data: {} });

    const result = await caller.mergePullRequest(ledgerMergeInput);

    expect(result).toEqual({ merged: true, sha: 'm1', branchDeleted: true });
    expect(t1Octokit.pulls.merge).toHaveBeenCalledTimes(1);
    expect(mockSettleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'completed',
        canonicalResult: { merged: true, sha: 'm1', branchDeleted: true },
      })
    );
  });

  it('marks a merge takeover reconcile-pending when the authoritative read fails (unresolved)', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'takeover',
      row: ledgerRow({ intent: 'merge', resource_key: mergeResourceKey }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    // The authoritative PR read fails (network / 5xx): the merge may or may
    // not have committed, so the row must stay reconcile-pending and the
    // merge must never re-execute under this key.
    t1Octokit.pulls.get.mockRejectedValueOnce({ status: 503, message: 'boom' });

    await expect(caller.mergePullRequest(ledgerMergeInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: PR_AMBIGUOUS_MESSAGE,
    });
    expect(mockMarkReconcilePending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rowId: 'ledger-row-1',
        outboxEvent: expect.objectContaining({
          eventName: 'pr_operation_settled',
          properties: expect.objectContaining({
            intent: 'merge',
            outcome: 'ambiguous',
            reconcile_result: 'unresolved',
          }),
        }),
      })
    );
    expect(mockSettleOperation).not.toHaveBeenCalled();
    expect(t1Octokit.pulls.merge).not.toHaveBeenCalled();
  });

  it('keeps an admitted merge reconcile-pending when the authoritative read returns NOT_FOUND', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'admitted',
      row: ledgerRow({ intent: 'merge', resource_key: mergeResourceKey }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    // The merge begins with an authoritative PR read; a NOT_FOUND there means
    // the PR state is READ-unavailable, which is ambiguous (the merge may or
    // may not have committed) — the row must never settle absent from a
    // failed read.
    t1Octokit.pulls.get.mockRejectedValueOnce({ status: 404, message: 'not found' });

    await expect(caller.mergePullRequest(ledgerMergeInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: PR_AMBIGUOUS_MESSAGE,
    });
    expect(mockMarkReconcilePending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rowId: 'ledger-row-1',
        outboxEvent: expect.objectContaining({
          eventName: 'pr_operation_settled',
          properties: expect.objectContaining({
            intent: 'merge',
            outcome: 'ambiguous',
            reconcile_result: 'unresolved',
          }),
        }),
      })
    );
    expect(mockSettleOperation).not.toHaveBeenCalled();
    expect(t1Octokit.pulls.merge).not.toHaveBeenCalled();
  });

  it('keeps a declined merge un-settled so a later same-key retry reconciles instead of re-merging', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'admitted',
      row: ledgerRow({ intent: 'merge', resource_key: mergeResourceKey }),
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.get.mockResolvedValueOnce({
      data: {
        state: 'open',
        head: { ref: 'feature/x', sha: 'a'.repeat(40), repo: { id: SAME_REPO_ID } },
        base: { ref: 'main', repo: { id: SAME_REPO_ID } },
      },
    });
    t1Octokit.pulls.merge.mockResolvedValueOnce({ data: { merged: false, sha: 's1' } });

    const result = await caller.mergePullRequest(ledgerMergeInput);

    expect(result).toEqual({ merged: false, sha: 's1', branchDeleted: false });
    // No settle: the row stays admitted so the next same-key retry can
    // reconcile the authoritative PR state before re-merging.
    expect(mockSettleOperation).not.toHaveBeenCalled();
    expect(mockMarkReconcilePending).not.toHaveBeenCalled();
  });

  it('surfaces a retryable server error when the completed settle fails after a committed provider write', async () => {
    // P1-A-08c + final PR finding: the GitHub effect committed but the ledger
    // settle failed. The router must NOT return the success receipt (the row
    // is still `admitted`, so a success would falsely claim a retry-safe
    // replay); it surfaces a retryable INTERNAL_SERVER_ERROR instead so a
    // same-key retry reconciles and settles the row.
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({ admission: 'admitted', row: ledgerRow() });
    mockSettleOperation.mockRejectedValueOnce(new Error('db unavailable'));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.createReviewComment.mockResolvedValueOnce({
      data: { id: 42, node_id: 'N_42' },
    });

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PR_LEDGER_SETTLE_FAILED_MESSAGE,
    });
    // The completed settle was attempted with the committed provider outcome…
    expect(mockSettleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'completed',
        canonicalResult: { commentId: 42, nodeId: 'N_42' },
      })
    );
    // …and the committed write is NEVER settled `failed` from the settle
    // failure (a `failed` row would falsely claim the action did not
    // complete and would drop the reconciliation evidence).
    expect(mockSettleOperation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed' })
    );
    // The canonical evidence is preserved on the non-terminal row so a
    // same-key retry can reconcile by re-reading comment 42 instead of
    // re-executing the write or losing the outcome.
    expect(mockRecordOperationAcceptance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rowId: 'ledger-row-1',
        providerRef: '42',
        canonicalResult: { commentId: 42, nodeId: 'N_42' },
      })
    );
    // …and no ambiguous/conflict marker leaked from the failure path.
    expect(mockMarkReconcilePending).not.toHaveBeenCalled();
  });

  it('surfaces the distinct non-retryable persistence error when reconcile-pending persistence fails on an ambiguous outcome', async () => {
    // The provider write went ambiguous (5xx) but `markReconcilePending`
    // failed: the row was never marked `reconcile_pending`, so the ambiguous
    // "check the PR before retrying" CONFLICT (which promises same-key
    // dedupe/reconcile) must NOT be surfaced. A distinct persistence error is
    // returned instead so the client cannot blind-retry the same key.
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({ admission: 'admitted', row: ledgerRow() });
    mockMarkReconcilePending.mockRejectedValueOnce(new Error('db unavailable'));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.createReviewComment.mockRejectedValueOnce({
      status: 503,
      message: 'Service unavailable',
    });

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PR_LEDGER_PERSISTENCE_FAILED_MESSAGE,
    });
    expect(mockMarkReconcilePending).toHaveBeenCalledTimes(1);
    // The ambiguous CONFLICT must never replace the hidden persistence failure,
    // and the row must never be settled from a failed mark.
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('surfaces the distinct persistence error when markReconcilePending returns no durable reconcile_pending row', async () => {
    // The ambiguous marker promises same-key dedupe/reconcile, which only
    // holds while the row is durably `reconcile_pending`. A null return (row
    // missing) or a no-op return (row not `admitted`) leaves the guarantee
    // unmet, so the distinct non-retryable persistence error is surfaced
    // instead of the ambiguous CONFLICT.
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({ admission: 'admitted', row: ledgerRow() });
    mockMarkReconcilePending.mockResolvedValueOnce(null);
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.createReviewComment.mockRejectedValueOnce({
      status: 503,
      message: 'Service unavailable',
    });

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PR_LEDGER_PERSISTENCE_FAILED_MESSAGE,
    });
    expect(mockMarkReconcilePending).toHaveBeenCalledTimes(1);
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('surfaces a retryable server error when a confirmed reconcile cannot settle (never replays an un-recorded row)', async () => {
    // The reconcile re-read confirmed the provider reference exists, but the
    // completed settle failed. A `replayed: true` success here would be a
    // false retry-safe receipt for a row that is still reconcile_pending, so
    // the retryable server error is surfaced instead.
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: ledgerRow({
        status: 'reconcile_pending',
        canonical_result: { commentId: 42, nodeId: 'N_42' },
      }),
    });
    mockSettleOperation.mockRejectedValueOnce(new Error('db unavailable'));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.getReviewComment.mockResolvedValueOnce({
      data: { id: 42, node_id: 'N_42' },
    });

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PR_LEDGER_SETTLE_FAILED_MESSAGE,
    });
    expect(mockSettleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'completed',
        canonicalResult: { commentId: 42, nodeId: 'N_42' },
        outboxEvent: expect.objectContaining({
          properties: expect.objectContaining({ reconcile_result: 'confirmed_completed' }),
        }),
      })
    );
    expect(t1Octokit.pulls.createReviewComment).not.toHaveBeenCalled();
  });

  it('surfaces the distinct persistence error when an unresolved takeover cannot mark reconcile-pending', async () => {
    // Takeover with no recorded provider reference: presence cannot be
    // confirmed, so the row must become `reconcile_pending` before the
    // ambiguous outcome is surfaced. When that persistence fails, the distinct
    // non-retryable persistence error is surfaced instead — never the ambiguous
    // marker and never a re-executed write.
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({ admission: 'takeover', row: ledgerRow() });
    mockMarkReconcilePending.mockRejectedValueOnce(new Error('db unavailable'));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');

    await expect(caller.createReviewComment(ledgerCommentInput)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PR_LEDGER_PERSISTENCE_FAILED_MESSAGE,
    });
    expect(t1Octokit.pulls.createReviewComment).not.toHaveBeenCalled();
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('surfaces the distinct persistence error when the merge reconcile read is unresolved and the mark fails', async () => {
    // The merge reconcile's authoritative read failed (unresolved), so the row
    // must stay reconcile-pending before the ambiguous outcome is surfaced.
    // When that persistence fails, the distinct non-retryable persistence
    // error is surfaced instead of the ambiguous marker.
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'takeover',
      row: ledgerRow({ intent: 'merge', resource_key: mergeResourceKey }),
    });
    mockMarkReconcilePending.mockRejectedValueOnce(new Error('db unavailable'));
    const caller = createCaller({ user: { id: 'user-1' } as User });
    const t1Octokit = buildOctokit('t1');
    t1Octokit.pulls.get.mockRejectedValueOnce({ status: 503, message: 'boom' });

    await expect(caller.mergePullRequest(ledgerMergeInput)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PR_LEDGER_PERSISTENCE_FAILED_MESSAGE,
    });
    expect(t1Octokit.pulls.merge).not.toHaveBeenCalled();
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });
});
