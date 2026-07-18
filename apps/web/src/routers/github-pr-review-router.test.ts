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
    },
    git: { deleteRef: jest.fn() },
    request: jest.fn(),
  };
  tokenOctokits.set(token, octokit);
  return octokit;
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
    firstOctokit.pulls.merge.mockResolvedValueOnce({
      data: { merged: true, sha: 'mergedsha', message: 'PR merged' },
    });

    const result = await caller.mergePullRequest({ ...baseMergeInput, isCrossRepo: true });

    expect(result).toEqual({ merged: true, sha: 'mergedsha', branchDeleted: false });
    expect(firstOctokit.pulls.merge).toHaveBeenCalledTimes(1);
    expect(firstOctokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it('skips the branch delete when deleteBranch=false', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const firstOctokit = buildOctokit('t1');
    firstOctokit.pulls.merge.mockResolvedValueOnce({
      data: { merged: true, sha: 'mergedsha', message: 'PR merged' },
    });

    const result = await caller.mergePullRequest({ ...baseMergeInput, deleteBranch: false });

    expect(result).toEqual({ merged: true, sha: 'mergedsha', branchDeleted: false });
    expect(firstOctokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it('reports branchDeleted=true on a successful same-repo delete', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const firstOctokit = buildOctokit('t1');
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
    buildOctokit('t1').request.mockResolvedValue({
      data: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      },
    });

    await expect(
      caller.listReviewThreads({ owner: 'octocat', repo: 'hello', number: 1, direction: 'forward' })
    ).resolves.toBeDefined();
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
