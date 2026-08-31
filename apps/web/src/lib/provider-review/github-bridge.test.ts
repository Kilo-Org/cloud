import { TRPCError } from '@trpc/server';
import type { User } from '@kilocode/db/schema';
import { user_terms_acceptances } from '@kilocode/db/schema';
import {
  githubPrReviewRouter,
  PR_REVIEW_GRAPHQL_DOCUMENTS,
} from '@/routers/github-pr-review-router';
import { repositoryResourceKey } from '@kilocode/app-shared/code-review/repository-identity';
import { providerReviewRouter } from '@/routers/provider-review-router';
import { createGitHubReviewBridge } from './github-bridge';
import { getGitHubUserAccessToken } from '@/lib/integrations/platforms/github/user-token-client';
import { createGitHubPrReviewOctokit } from '@/lib/github-pr-review/client';
import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';

jest.mock('@/lib/trpc/init', () => {
  const t = jest.requireActual('@trpc/server').initTRPC.create();
  return { baseProcedure: t.procedure, createTRPCRouter: t.router };
});
jest.mock('@/lib/config.server', () => ({}));
jest.mock('@/lib/tokens', () => ({}));
jest.mock('@/routers/organizations/utils', () => ({ ensureOrganizationAccess: jest.fn() }));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getAllIntegrationsForOwner: jest.fn(),
}));
jest.mock('@/lib/provider-review/gitlab-authorization', () => ({}));
jest.mock('@/lib/provider-review/gitlab-read', () => ({}));
jest.mock('@/lib/provider-review/bitbucket-read', () => ({}));
jest.mock('@/lib/provider-review/gitlab-write', () => ({}));
jest.mock('@/lib/provider-review/bitbucket-write', () => ({}));
jest.mock('@/lib/integrations/platforms/github/user-token-client', () => ({
  getGitHubUserAccessToken: jest.fn(),
}));
jest.mock('@/lib/github-pr-review/client', () => ({ createGitHubPrReviewOctokit: jest.fn() }));
jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === user_terms_acceptances) {
              await gates.terms();
              return termsAccepted ? [{ id: 'terms' }] : [];
            }
            return row ? [row] : [];
          },
        }),
      }),
    }),
  },
}));
jest.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: async (_db: unknown, input: any) => {
    await gates.admission();
    if (row)
      return {
        admission: row.status === 'completed' ? 'duplicate_settled' : 'duplicate_reconcile_pending',
        row,
      };
    row = {
      id: 'ledger-row',
      intent: input.intent,
      resource_key: input.resourceKey,
      status: 'admitted',
      canonical_result: null,
    };
    return { admission: 'admitted', row };
  },
  settleOperation: async (_db: unknown, input: any) => {
    row.status = input.status;
    row.canonical_result = input.canonicalResult;
  },
  recordOperationAcceptance: async (_db: unknown, input: any) => {
    row.canonical_result = input.canonicalResult;
  },
  markReconcilePending: async () => {
    row.status = 'reconcile_pending';
    return row;
  },
}));

const ctx = { user: { id: 'oauth/caller' } as User };
const direct = githubPrReviewRouter.createCaller(ctx);
const facade = providerReviewRouter.createCaller(ctx);
const address = { owner: 'Team', repo: 'Repo', number: 7 };
const operationKey = '55555555-5555-4555-8555-555555555555';
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const repo = {
  id: 42,
  full_name: 'Team/Repo',
  default_branch: 'trunk',
  allow_merge_commit: true,
  allow_squash_merge: true,
  allow_rebase_merge: false,
  allow_auto_merge: true,
  allow_update_branch: true,
  permissions: { push: true, admin: false },
};
const octokit = {
  users: { getAuthenticated: jest.fn() },
  pulls: {
    get: jest.fn(),
    listFiles: jest.fn(),
    createReview: jest.fn(),
    createReviewComment: jest.fn(),
    createReplyForReviewComment: jest.fn(),
    getReview: jest.fn(),
    getReviewComment: jest.fn(),
    merge: jest.fn(),
    updateBranch: jest.fn(),
  },
  repos: {
    get: jest.fn(),
    compareCommits: jest.fn(),
    getContent: jest.fn(),
    listCommitStatusesForRef: jest.fn(),
  },
  checks: { listForRef: jest.fn() },
  issues: { listComments: jest.fn() },
  git: { deleteRef: jest.fn() },
  paginate: jest.fn(),
  request: jest.fn(),
};
const gates = { terms: jest.fn(), admission: jest.fn() };
let row: any;
let termsAccepted: boolean;
let writes: unknown[];
let pull: any;
let inbox: any[];

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(createGitHubPrReviewOctokit).mockReturnValue(octokit as any);
  row = null;
  termsAccepted = true;
  writes = [];
  inbox = [];
  pull = {
    node_id: 'PR_7',
    number: 7,
    title: 'Review me',
    body: 'Description',
    user: { login: 'author', avatar_url: 'https://avatars.example/author' },
    state: 'open',
    draft: false,
    merged: false,
    base: { ref: 'trunk', sha: baseSha, repo },
    head: { ref: 'feature', sha: headSha, repo },
    commits: 1,
    changed_files: 0,
    additions: 0,
    deletions: 0,
    mergeable: true,
    mergeable_state: 'clean',
  };
  jest.mocked(getGitHubUserAccessToken).mockResolvedValue({
    status: 'connected',
    credential: {
      connected: true,
      token: 'fixture-token',
      expiresAtEpochMs: Date.now() + 3600000,
      githubLogin: 'reviewer',
      authorizationId: 'authorization-1',
      credentialVersion: 1,
    },
  });
  jest.mocked(getAllIntegrationsForOwner).mockResolvedValue([]);
  octokit.users.getAuthenticated.mockResolvedValue({
    data: { id: 99, login: 'reviewer', name: 'Reviewer' },
  });
  octokit.repos.get.mockResolvedValue({ data: repo });
  octokit.repos.compareCommits.mockResolvedValue({ data: { merge_base_commit: { sha: baseSha } } });
  octokit.pulls.get.mockImplementation(async () => ({ data: pull }));
  octokit.pulls.listFiles.mockResolvedValue({ data: [] });
  octokit.paginate.mockResolvedValue([]);
  octokit.issues.listComments.mockResolvedValue({ data: [] });
  octokit.request.mockImplementation(async (_route, input) => ({
    data: {
      data: input.variables?.q
        ? { search: { nodes: inbox, pageInfo: { hasNextPage: false, endCursor: null } } }
        : {
            repository: {
              pullRequest: {
                reviewDecision: 'APPROVED',
                reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
            viewer: { login: 'reviewer' },
          },
    },
  }));
  octokit.pulls.createReview.mockImplementation(async input => {
    writes.push(input);
    return {
      data: {
        id: 81,
        node_id: 'REVIEW_81',
        state:
          input.event === 'APPROVE'
            ? 'APPROVED'
            : input.event === 'REQUEST_CHANGES'
              ? 'CHANGES_REQUESTED'
              : 'COMMENTED',
      },
    };
  });
  octokit.pulls.createReviewComment.mockImplementation(async input => {
    writes.push(input);
    return { data: { id: 82, node_id: 'COMMENT_82' } };
  });
  octokit.pulls.getReview.mockResolvedValue({
    data: { id: 81, node_id: 'REVIEW_81', state: 'COMMENTED' },
  });
});
afterEach(() => expect(getAllIntegrationsForOwner).not.toHaveBeenCalled());

it.each([0, 2])(
  'AC10 direct reads, facade reads, inbox, paste and restored drafts ignore %s installations',
  async count => {
    jest.mocked(getAllIntegrationsForOwner).mockResolvedValue(
      Array.from({ length: count }, (_, index) => ({
        id: `unrelated-${index}`,
        platform: 'github',
      })) as any
    );
    const old = await direct.getPullRequest(address);
    expect(old).toMatchObject({ number: 7, headSha, repo: { viewerLogin: 'reviewer' } });
    expect(old).not.toHaveProperty('identity');
    const overview = await facade.getReview({ review: address });
    expect(overview.identity).toEqual({
      repository: {
        provider: 'github',
        instanceUrl: 'https://github.com',
        repositoryId: '42',
        fullName: 'Team/Repo',
        defaultBranch: 'trunk',
      },
      authorization: {
        kind: 'githubUser',
        accountId: ctx.user.id,
        authorizationId: 'authorization-1',
      },
      reviewId: 'PR_7',
      number: '7',
      canonicalUrl: 'https://github.com/Team/Repo/pull/7',
    });
    expect(overview.authorization.actor).toMatchObject({ id: '99', login: 'reviewer' });
    inbox = [
      {
        number: 7,
        title: 'Assigned review',
        isDraft: false,
        updatedAt: '2026-08-30T00:00:00Z',
        author: null,
        repository: { name: 'Repo', owner: { login: 'Team' } },
      },
    ];
    expect(await direct.listInbox({})).toEqual({
      items: [
        {
          ...address,
          title: 'Assigned review',
          isDraft: false,
          updatedAt: '2026-08-30T00:00:00Z',
          author: null,
        },
      ],
      nextCursor: null,
    });
    expect(await facade.listInbox({})).toMatchObject({
      items: [{ identity: overview.identity, title: 'Assigned review' }],
      scope: { kind: 'actor', actor: { id: '99' } },
    });
    expect(
      await facade.resolveUrl({ url: 'http://www.github.com/Team/Repo/pull/7/files#diff' })
    ).toEqual(overview.identity);
    const saved = JSON.parse(
      '{"owner":"Team","repo":"Repo","number":7,"accountId":"oauth/caller","futureField":{"unknown":true}}'
    );
    expect((await facade.getReview({ review: saved })).identity).toEqual(overview.identity);
  }
);
it('AC10 normalizes absent provider and default metadata without guessing a branch', async () => {
  const oldRepo = { ...repo, default_branch: undefined };
  octokit.repos.get.mockResolvedValue({ data: oldRepo });
  pull.base = { ...pull.base, sha: undefined, repo: oldRepo };
  const overview = await facade.getReview({
    review: { repository: { fullName: 'Team/Repo' }, number: 7 },
  });
  expect(overview.identity.repository.defaultBranch).toBeNull();
  expect(overview.revision).toEqual({
    headSha,
    baseSha: null,
    startSha: null,
    targetHeadSha: null,
  });
  expect(overview.checks).toEqual({ status: 'none', checks: [] });
});
it.each(['not_connected', 'revoked'] as const)(
  'AC10 preserves %s user errors even with installation access',
  async reason => {
    jest
      .mocked(getAllIntegrationsForOwner)
      .mockResolvedValue([{ platform: 'github', id: 'installed' }] as any);
    jest.mocked(getGitHubUserAccessToken).mockResolvedValue({ status: 'disconnected', reason });
    const oldError = await direct.getPullRequest(address).catch(error => error);
    await expect(facade.getReview({ review: address })).rejects.toMatchObject({
      code: oldError.code,
      message: oldError.message,
    });
    expect(await facade.getAuthorization({})).toEqual({
      status: 'not_connected',
      reason,
      authorization: null,
      actor: null,
    });
    expect(writes).toEqual([]);
  }
);
it.each([403, 404, 429, 503])(
  'AC10 preserves GitHub HTTP %s error classification',
  async status => {
    octokit.pulls.get.mockRejectedValue({ status });
    const oldError = await direct.getPullRequest(address).catch(error => error);
    await expect(facade.getReview({ review: address })).rejects.toMatchObject({
      code: oldError.code,
      message: oldError.message,
    });
  }
);
it('AC10 retries a rejected user token through the existing rotation path', async () => {
  octokit.pulls.get.mockRejectedValueOnce({ status: 401 });
  const overview = await facade.getReview({ review: address });
  expect(overview.title).toBe('Review me');
  expect(getGitHubUserAccessToken).toHaveBeenCalledWith(ctx.user.id, {
    op: 'rotate',
    staleAuthorizationId: 'authorization-1',
    staleCredentialVersion: 1,
  });
});
it('AC10 fences restored authorization and account changes before a write', async () => {
  const overview = await facade.getReview({ review: address });
  const identity = structuredClone(overview.identity);
  if (identity.authorization.kind !== 'githubUser') throw new Error('fixture');
  identity.authorization.authorizationId = 'previous-authorization';
  await expect(facade.getReview({ review: identity })).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(
    facade.getReview({ review: { ...address, accountId: 'other-account' } })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(writes).toEqual([]);
});
it('AC4–AC5 keeps empty files, checks, discussions and closed reviews readable', async () => {
  pull.state = 'closed';
  const overview = await facade.getReview({ review: address });
  expect(overview.state).toBe('closed');
  expect(
    await facade.listFiles({ review: overview.identity, revision: overview.revision })
  ).toMatchObject({ items: [], nextCursor: null, authorization: { actor: { id: '99' } } });
  expect(
    await facade.listChecks({ review: overview.identity, revision: overview.revision })
  ).toMatchObject({ checks: { status: 'none', checks: [] } });
  expect(await facade.listDiscussions({ review: overview.identity })).toMatchObject({
    items: [],
    nextCursor: null,
  });
});
it('AC5 binds renamed old-side context to the immutable merge base', async () => {
  octokit.pulls.listFiles.mockResolvedValue({
    data: [
      {
        filename: 'new.ts',
        previous_filename: 'old.ts',
        status: 'renamed',
        additions: 1,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    ],
  });
  octokit.repos.getContent.mockImplementation(async input => ({
    data:
      input.owner === 'Team' &&
      input.repo === 'Repo' &&
      input.ref === baseSha &&
      input.path === 'old.ts'
        ? 'old-value\nsecond'
        : 'WRONG REVISION',
  }));
  const overview = await facade.getReview({ review: address });
  const files = await facade.listFiles({ review: overview.identity, revision: overview.revision });
  expect(files.items[0]).toMatchObject({
    oldPath: 'old.ts',
    newPath: 'new.ts',
    revision: overview.revision,
  });
  const context = await facade.getFileContext({
    review: overview.identity,
    context: { file: files.items[0], side: 'old', startLine: 1, lineCount: 1 },
  });
  expect(context).toMatchObject({
    lines: ['old-value'],
    content: 'available',
    canonicalUrl: `https://github.com/Team/Repo/blob/${baseSha}/old.ts`,
  });
  await expect(
    facade.listFiles({
      review: overview.identity,
      revision: { ...overview.revision, headSha: 'c'.repeat(40) },
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});
it('AC10 replays a direct GitHub submission through the facade without changing ledger bytes', async () => {
  const legacy = {
    ...address,
    operationKey,
    event: 'COMMENT' as const,
    body: 'Keep this summary',
    commitSha: headSha,
  };
  expect(await direct.submitReview(legacy)).toEqual({
    reviewId: 81,
    nodeId: 'REVIEW_81',
    state: 'COMMENTED',
  });
  const savedKey = row.resource_key;
  const overview = await facade.getReview({ review: address });
  const input = {
    review: overview.identity,
    actorId: '99',
    revision: overview.revision,
    operationKey,
    input: {
      action: 'submitReview' as const,
      body: 'Keep this summary',
      choice: 'comment' as const,
    },
  };
  expect(await facade.act(input)).toMatchObject({
    result: { status: 'confirmed', reference: { id: '81' } },
  });
  expect(row.resource_key).toBe(savedKey);
  expect(writes).toHaveLength(1);
  expect(await facade.getOperationStatus(input)).toMatchObject({ result: { status: 'confirmed' } });
  expect(writes).toHaveLength(1);
});
it('AC6 keeps the legacy Terms gate before any provider effect', async () => {
  termsAccepted = false;
  const overview = await facade.getReview({ review: address });
  await expect(
    facade.act({
      review: overview.identity,
      actorId: '99',
      revision: overview.revision,
      operationKey,
      input: { action: 'comment', body: 'Retain my draft' },
    })
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'terms_required' });
  expect(writes).toEqual([]);
  expect(row).toBeNull();
});
it('AC6 preserves the ambiguous marker and never repeats a lost submission', async () => {
  octokit.pulls.createReview.mockImplementation(async input => {
    writes.push(input);
    throw { status: 503 };
  });
  const overview = await facade.getReview({ review: address });
  const input = {
    review: overview.identity,
    actorId: '99',
    revision: overview.revision,
    operationKey,
    input: { action: 'comment' as const, body: 'One effect' },
  };
  await expect(facade.act(input)).rejects.toMatchObject({
    code: 'CONFLICT',
    message: "Couldn't confirm — check the PR before retrying.",
  });
  expect(await facade.getOperationStatus(input)).toMatchObject({
    result: { status: 'unresolved', retry: 'reconcile' },
  });
  await expect(facade.act(input)).rejects.toMatchObject({
    code: 'CONFLICT',
    message: "Couldn't confirm — check the PR before retrying.",
  });
  expect(writes).toHaveLength(1);
});
it('AC6 refuses a changed submitted intent instead of replaying its receipt', async () => {
  await direct.submitReview({
    ...address,
    operationKey,
    event: 'COMMENT',
    body: 'Original',
    commitSha: headSha,
  });
  const overview = await facade.getReview({ review: address });
  await expect(
    facade.act({
      review: overview.identity,
      actorId: '99',
      revision: overview.revision,
      operationKey,
      input: { action: 'comment', body: 'Changed' },
    })
  ).rejects.toMatchObject({ code: 'CONFLICT', message: 'operation_key_reuse_mismatch' });
  expect(writes).toHaveLength(1);
});
it('AC6 rejects a stale unadmitted revision and leaves no write or ledger row', async () => {
  const overview = await facade.getReview({ review: address });
  await expect(
    facade.act({
      review: overview.identity,
      actorId: '99',
      revision: { ...overview.revision, headSha: 'c'.repeat(40) },
      operationKey,
      input: { action: 'comment', body: 'Original selection' },
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(writes).toEqual([]);
  expect(row).toBeNull();
});
it('AC6 does not admit a new operation from its status query', async () => {
  const overview = await createGitHubReviewBridge(ctx).getReview(address);
  expect(
    await facade.getOperationStatus({
      review: overview.identity,
      actorId: '99',
      revision: overview.revision,
      operationKey,
      input: { action: 'comment', body: 'Not sent' },
    })
  ).toMatchObject({ result: { status: 'rejected', code: 'operation_not_admitted' } });
  expect(writes).toEqual([]);
  expect(row).toBeNull();
});
it.each([
  'https://github.com/Team/Repo/issues/7',
  'https://github.com/Team/Repo/pull/0',
  'https://github.com/Team/Repo/pull/7/arbitrary',
])('AC10 rejects invalid GitHub entry %s', async url => {
  await expect(facade.resolveUrl({ url })).rejects.toBeInstanceOf(TRPCError);
  expect(octokit.pulls.get).not.toHaveBeenCalled();
});
it('AC4 keeps pending and error commit statuses distinct', async () => {
  octokit.paginate.mockImplementation(async method =>
    method === octokit.repos.listCommitStatusesForRef
      ? [
          { context: 'pending-build', state: 'pending', target_url: null, updated_at: null },
          { context: 'failed-build', state: 'error', target_url: null, updated_at: null },
        ]
      : []
  );
  expect((await facade.getReview({ review: address })).checks).toMatchObject({
    status: 'reported',
    checks: [
      { name: 'pending-build', state: 'pending' },
      { name: 'failed-build', state: 'failed' },
    ],
  });
});
it('AC10 never confirms a legacy ledger row without a provider receipt', async () => {
  await direct.submitReview({
    ...address,
    operationKey,
    event: 'COMMENT',
    body: 'Original',
    commitSha: headSha,
  });
  row.canonical_result = { futureField: true };
  const overview = await facade.getReview({ review: address });
  expect(
    await facade.getOperationStatus({
      review: overview.identity,
      actorId: '99',
      revision: overview.revision,
      operationKey,
      input: { action: 'comment', body: 'Original' },
    })
  ).toMatchObject({ result: { status: 'unresolved', retry: 'reconcile' } });
  expect(writes).toHaveLength(1);
});
it('AC6 rejects fields the selected GitHub action cannot preserve', async () => {
  const overview = await facade.getReview({ review: address });
  await expect(
    facade.act({
      review: overview.identity,
      actorId: '99',
      revision: overview.revision,
      operationKey,
      input: { action: 'comment', body: 'Original', squash: true },
    })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(writes).toEqual([]);
});
it('AC7 denies an unavailable merge grant without disabling reads', async () => {
  octokit.repos.get.mockResolvedValue({ data: { ...repo, permissions: { push: false } } });
  octokit.pulls.merge.mockImplementation(async input => {
    writes.push(input);
    return { data: { merged: true, sha: 'merged' } };
  });
  const overview = await facade.getReview({ review: address });
  expect(overview.authorization.capabilities.read.permission).toBe('allowed');
  await expect(
    facade.act({
      review: overview.identity,
      actorId: '99',
      revision: overview.revision,
      operationKey,
      input: { action: 'merge', method: 'squash' },
    })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(writes).toEqual([]);
});

async function actionInput(input: Parameters<typeof facade.act>[0]['input']) {
  const overview = await facade.getReview({ review: address });
  return {
    review: overview.identity,
    revision: overview.revision,
    actorId: overview.authorization.actor.id,
    operationKey,
    input,
  };
}

function mockGitHubActions(validReceipt = true) {
  const original = octokit.request.getMockImplementation();
  if (!original) throw new Error('Missing GraphQL fixture');
  const state = { resolved: false, reacted: false };
  const pageInfo = { hasNextPage: false, endCursor: null };
  const docs = PR_REVIEW_GRAPHQL_DOCUMENTS;
  octokit.request.mockImplementation(async (route, request) => {
    const variables = request.variables?.input;
    const query = request.query;
    if (query === docs.REVIEW_THREADS_QUERY) {
      return {
        data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo,
                  nodes: [
                    {
                      id: 'THREAD_11',
                      isResolved: state.resolved,
                      isOutdated: false,
                      subjectType: 'LINE',
                      path: 'new.ts',
                      line: 4,
                      diffSide: 'RIGHT',
                      comments: {
                        pageInfo,
                        nodes: [
                          {
                            databaseId: 11,
                            id: 'COMMENT_11',
                            body: 'Original comment',
                            createdAt: '2026-08-30T00:00:00Z',
                            author: null,
                            reactionGroups: [
                              {
                                content: 'THUMBS_UP',
                                reactors: { totalCount: 1 },
                                viewerHasReacted: state.reacted,
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
    if (query === docs.RESOLVE_THREAD_MUTATION || query === docs.UNRESOLVE_THREAD_MUTATION) {
      const resolve = query === docs.RESOLVE_THREAD_MUTATION;
      writes.push({ action: resolve ? 'resolve' : 'reopen', ...variables });
      if (validReceipt) state.resolved = resolve;
      return {
        data: {
          data: {
            [resolve ? 'resolveReviewThread' : 'unresolveReviewThread']: {
              thread: {
                id: validReceipt ? 'THREAD_11' : 'OTHER_THREAD',
                isResolved: state.resolved,
              },
            },
          },
        },
      };
    }
    if (query === docs.ADD_REACTION_MUTATION || query === docs.REMOVE_REACTION_MUTATION) {
      const add = query === docs.ADD_REACTION_MUTATION;
      writes.push({ action: add ? 'react' : 'unreact', ...variables });
      if (validReceipt) state.reacted = add;
      return {
        data: {
          data: {
            [add ? 'addReaction' : 'removeReaction']: {
              reaction: { content: validReceipt ? 'THUMBS_UP' : 'HEART' },
            },
          },
        },
      };
    }
    if (query === docs.ENABLE_AUTO_MERGE_MUTATION || query === docs.DISABLE_AUTO_MERGE_MUTATION) {
      const enable = query === docs.ENABLE_AUTO_MERGE_MUTATION;
      writes.push({ action: enable ? 'enable' : 'disable', ...variables });
      if (validReceipt)
        pull.auto_merge = enable ? { merge_method: variables.mergeMethod.toLowerCase() } : null;
      return {
        data: {
          data: {
            [enable ? 'enablePullRequestAutoMerge' : 'disablePullRequestAutoMerge']: {
              pullRequest: { id: validReceipt ? 'PR_7' : 'OTHER_PR' },
            },
          },
        },
      };
    }
    return original(route, request);
  });
  octokit.pulls.createReplyForReviewComment.mockImplementation(async input => {
    writes.push(input);
    return { data: { id: 83, node_id: 'COMMENT_83' } };
  });
  return state;
}

it.each([
  ['comment', undefined, 'COMMENT'],
  ['approve', undefined, 'APPROVE'],
  ['requestChanges', undefined, 'REQUEST_CHANGES'],
  ['submitReview', 'comment', 'COMMENT'],
  ['submitReview', 'approve', 'APPROVE'],
  ['submitReview', 'requestChanges', 'REQUEST_CHANGES'],
] as const)('AC10 maps %s/%s to the unchanged %s ledger intent', async (action, choice, event) => {
  await direct.submitReview({
    ...address,
    operationKey,
    event,
    body: 'Summary',
    commitSha: headSha,
  });
  const savedKey = row.resource_key;
  const input = await actionInput({ action, body: 'Summary', ...(choice ? { choice } : {}) });
  expect(await facade.act(input)).toMatchObject({
    result: { status: 'confirmed', reference: { id: '81' } },
  });
  expect(writes).toEqual([
    { owner: 'Team', repo: 'Repo', pull_number: 7, event, commit_id: headSha, body: 'Summary' },
  ]);
  expect(row.resource_key).toBe(savedKey);
});

it('AC6 maps both batch sides and ranges without changing legacy fingerprint ordering', async () => {
  const input = await actionInput({ action: 'submitReview', choice: 'approve', body: 'Summary' });
  input.input.comments = [
    {
      itemId: 'old',
      body: 'Old range',
      position: {
        revision: input.revision,
        oldPath: 'old.ts',
        newPath: 'new.ts',
        side: 'old',
        line: 4,
        startLine: 2,
        startSide: 'old',
        native: { provider: 'github' },
      },
    },
    {
      itemId: 'new',
      body: 'New line',
      position: {
        revision: input.revision,
        oldPath: null,
        newPath: 'added.ts',
        side: 'new',
        line: 8,
        native: { provider: 'github' },
      },
    },
  ];
  await direct.submitReview({
    ...address,
    operationKey,
    event: 'APPROVE',
    body: 'Summary',
    commitSha: headSha,
    comments: [
      { path: 'new.ts', line: 4, side: 'LEFT', startLine: 2, startSide: 'LEFT', body: 'Old range' },
      { path: 'added.ts', line: 8, side: 'RIGHT', body: 'New line' },
    ],
  });
  expect(await facade.act(input)).toMatchObject({ result: { status: 'confirmed' } });
  expect(writes).toHaveLength(1);
});

it.each(['comment', 'inlineComment', 'reply'] as const)(
  'AC6 recovers the recorded %s receipt without another write',
  async action => {
    mockGitHubActions();
    const input = await actionInput({ action, body: 'One effect' });
    if (action === 'inlineComment')
      input.input.position = {
        revision: input.revision,
        oldPath: 'old.ts',
        newPath: 'new.ts',
        side: 'old',
        line: 4,
        startLine: 2,
        startSide: 'old',
        native: { provider: 'github' },
      };
    if (action === 'reply')
      input.input.target = { provider: 'github', kind: 'comment', id: 'COMMENT_11', url: null };
    expect(await facade.act(input)).toMatchObject({ result: { status: 'confirmed' } });
    const receiptId = action === 'comment' ? 81 : action === 'inlineComment' ? 82 : 83;
    octokit.pulls.getReviewComment.mockResolvedValue({
      data: { id: receiptId, node_id: `COMMENT_${receiptId}` },
    });
    row.status = 'reconcile_pending';
    row.canonical_result.futureField = 'ignored';
    const recorded = structuredClone(row);
    expect(await facade.getOperationStatus(input)).toMatchObject({
      result: { status: 'confirmed', reference: { id: String(receiptId) } },
    });
    expect(row).toEqual(recorded);
    expect(writes).toHaveLength(1);
    if (action === 'inlineComment')
      expect(writes[0]).toMatchObject({
        path: 'new.ts',
        line: 4,
        side: 'LEFT',
        start_line: 2,
        start_side: 'LEFT',
        commit_id: headSha,
      });
    if (action === 'reply')
      expect(writes[0]).toMatchObject({ comment_id: 11, body: 'One effect', pull_number: 7 });
  }
);

it.each([404, 503, 'wrong-id', 'absent-reference'] as const)(
  'AC6 keeps unavailable receipt %s unresolved',
  async failure => {
    const input = await actionInput({ action: 'comment', body: 'One effect' });
    await facade.act(input);
    row.status = 'reconcile_pending';
    if (failure === 'absent-reference') row.canonical_result = { futureField: true };
    else if (failure === 'wrong-id')
      octokit.pulls.getReview.mockResolvedValue({ data: { id: 999, node_id: 'OTHER' } });
    else octokit.pulls.getReview.mockRejectedValue({ status: failure });
    expect(await facade.getOperationStatus(input)).toMatchObject({
      result: { status: 'unresolved', retry: 'reconcile' },
    });
    expect(writes).toHaveLength(1);
    expect(row.status).toBe('reconcile_pending');
  }
);

it('AC10 retains the casing of a legacy ledger address after canonical normalization', async () => {
  await direct.submitReview({
    owner: 'team',
    repo: 'repo',
    number: 7,
    operationKey,
    event: 'COMMENT',
    body: 'Summary',
    commitSha: headSha,
  });
  const savedKey = row.resource_key;
  const input = await actionInput({ action: 'comment', body: 'Summary' });
  expect(await facade.act(input)).toMatchObject({ result: { status: 'confirmed' } });
  expect(await facade.getOperationStatus(input)).toMatchObject({ result: { status: 'confirmed' } });
  expect(row.resource_key).toBe(savedKey);
  expect(writes).toHaveLength(1);
  await expect(
    facade.act({ ...input, input: { action: 'comment', body: 'Different' } })
  ).rejects.toMatchObject({ code: 'CONFLICT', message: 'operation_key_reuse_mismatch' });
  expect(writes).toHaveLength(1);
});

it.each([
  ['merge', 'keep'],
  ['squash', 'delete'],
  ['rebase', 'fail'],
] as const)('AC7 maps %s merge and %s deletion through the old path', async (method, deletion) => {
  octokit.repos.get.mockResolvedValue({ data: { ...repo, allow_rebase_merge: true } });
  octokit.pulls.merge.mockImplementation(async input => {
    writes.push(input);
    return { data: { merged: true, sha: 'merged' } };
  });
  octokit.git.deleteRef.mockImplementation(async input => {
    writes.push(input);
    if (deletion === 'fail') throw new Error('Deletion failed');
    return { data: {} };
  });
  const input = await actionInput({
    action: 'merge',
    method,
    commitTitle: 'Title',
    commitMessage: 'Message',
  });
  input.input.deletion = {
    effect: deletion === 'keep' ? 'keep' : 'delete',
    repositoryKey: repositoryResourceKey(ctx.user.id, input.review),
    branch: 'feature',
    expectedHeadSha: headSha,
  };
  const result = await facade.act(input);
  expect(result).toMatchObject({
    result: { status: deletion === 'fail' ? 'partial' : 'confirmed' },
  });
  expect(writes).toEqual([
    {
      owner: 'Team',
      repo: 'Repo',
      pull_number: 7,
      merge_method: method,
      sha: headSha,
      commit_title: 'Title',
      commit_message: 'Message',
    },
    ...(deletion === 'keep' ? [] : [{ owner: 'Team', repo: 'Repo', ref: 'heads/feature' }]),
  ]);
  if (deletion === 'fail')
    expect(result.result).toMatchObject({
      items: [
        { effect: 'merge', result: { status: 'confirmed' } },
        { effect: 'deleteBranch', result: { status: 'unresolved' } },
      ],
    });
  const effects = structuredClone(writes);
  expect(await facade.getOperationStatus(input)).toEqual(result);
  expect(writes).toEqual(effects);
});

it.each([true, false])('AC7 recovers a lost merge response only when merged=%s', async merged => {
  const input = await actionInput({ action: 'merge', method: 'squash' });
  octokit.pulls.merge.mockImplementation(async value => {
    writes.push(value);
    throw { status: 503 };
  });
  await expect(facade.act(input)).rejects.toMatchObject({ code: 'CONFLICT' });
  pull.state = 'closed';
  pull.merged = merged;
  const pending = structuredClone(row);
  expect(await facade.getOperationStatus(input)).toMatchObject({
    result: { status: merged ? 'confirmed' : 'unresolved' },
  });
  expect(await facade.act(input)).toMatchObject({
    result: { status: merged ? 'confirmed' : 'unresolved' },
  });
  expect(row).toEqual(pending);
  expect(writes).toHaveLength(1);
});

describe.each([
  ['resolveThread', { action: 'resolve', threadId: 'THREAD_11' }],
  ['reopenThread', { action: 'reopen', threadId: 'THREAD_11' }],
  ['addReaction', { action: 'react', subjectId: 'COMMENT_11', content: 'THUMBS_UP' }],
  ['removeReaction', { action: 'unreact', subjectId: 'COMMENT_11', content: 'THUMBS_UP' }],
  ['enableAutoMerge', { action: 'enable', pullRequestId: 'PR_7', mergeMethod: 'SQUASH' }],
  ['disableAutoMerge', { action: 'disable', pullRequestId: 'PR_7' }],
] as const)('AC6–AC7 %s mapping and recovery', (action, expected) => {
  it.each([true, false])('confirms only a matching receipt: %s', async validReceipt => {
    const state = mockGitHubActions(validReceipt);
    state.resolved = action === 'reopenThread';
    state.reacted = action === 'removeReaction';
    if (action === 'disableAutoMerge') pull.auto_merge = { merge_method: 'squash' };
    const input = await actionInput({ action });
    if (action === 'resolveThread' || action === 'reopenThread')
      input.input.target = { provider: 'github', kind: 'thread', id: 'THREAD_11', url: null };
    if (action === 'addReaction' || action === 'removeReaction') {
      input.input.target = { provider: 'github', kind: 'comment', id: 'COMMENT_11', url: null };
      input.input.reaction = 'THUMBS_UP';
    }
    if (action === 'enableAutoMerge') input.input.method = 'squash';
    expect(await facade.getOperationStatus(input)).toMatchObject({
      result: { status: 'unresolved' },
    });
    expect(writes).toEqual([]);
    expect(await facade.act(input)).toMatchObject({
      result: { status: validReceipt ? 'confirmed' : 'unresolved' },
    });
    expect(writes).toEqual([expected]);
    expect(await facade.getOperationStatus(input)).toMatchObject({
      result: { status: validReceipt ? 'confirmed' : 'unresolved' },
    });
    expect(writes).toEqual([expected]);
  });
});

it.each(['both', 'source-only', 'target-only', 'unrelated'] as const)(
  'AC7 confirms branch update only with both original ancestors: %s',
  async ancestry => {
    const input = await actionInput({ action: 'updateBranch' });
    octokit.pulls.updateBranch.mockImplementation(async value => {
      writes.push(value);
      return { data: { message: 'Updating' } };
    });
    expect(await facade.act(input)).toMatchObject({
      result: { status: 'accepted', retry: 'reconcile' },
    });
    const updatedHead = 'c'.repeat(40);
    pull.head.sha = updatedHead;
    octokit.repos.compareCommits.mockImplementation(async value => ({
      data: {
        merge_base_commit: {
          sha:
            value.head === updatedHead &&
            ((value.base === headSha && ['both', 'source-only'].includes(ancestry)) ||
              (value.base === baseSha && ['both', 'target-only'].includes(ancestry)))
              ? value.base
              : 'd'.repeat(40),
        },
      },
    }));
    expect(await facade.getOperationStatus(input)).toMatchObject({
      result: { status: ancestry === 'both' ? 'confirmed' : 'unresolved' },
    });
    expect(writes).toEqual([
      { owner: 'Team', repo: 'Repo', pull_number: 7, expected_head_sha: headSha },
    ]);
  }
);

it('AC7 rejects the implicit auto-merge method when the repository disables it', async () => {
  mockGitHubActions();
  octokit.repos.get.mockResolvedValue({ data: { ...repo, allow_merge_commit: false } });
  const input = await actionInput({ action: 'enableAutoMerge' });
  await expect(facade.act(input)).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'merge_method_not_available',
  });
  expect(writes).toEqual([]);
});

it('AC6 reports a rejected ledger operation as terminal rather than unknown', async () => {
  const input = await actionInput({ action: 'comment', body: 'No permission' });
  octokit.pulls.createReview.mockImplementation(async value => {
    writes.push(value);
    throw { status: 403 };
  });
  await expect(facade.act(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(await facade.getOperationStatus(input)).toMatchObject({
    result: { status: 'rejected', retry: 'never' },
  });
  expect(writes).toHaveLength(1);
});

it.each(['repositoryKey', 'branch', 'expectedHeadSha'] as const)(
  'AC7 rejects changed deletion %s without a merge',
  async field => {
    const input = await actionInput({ action: 'merge', method: 'squash' });
    input.input.deletion = {
      effect: 'delete',
      repositoryKey: repositoryResourceKey(ctx.user.id, input.review),
      branch: 'feature',
      expectedHeadSha: headSha,
    };
    input.input.deletion[field] = 'other';
    await expect(facade.act(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(writes).toEqual([]);
    expect(row).toBeNull();
  }
);

it.each(['unapprove', 'removeChangeRequest', 'deleteBranch'] as const)(
  'AC10 refuses %s without inventing a legacy procedure',
  async action => {
    const input = await actionInput({ action });
    await expect(facade.act(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(writes).toEqual([]);
    expect(row).toBeNull();
  }
);

it.each(['PENDING', 'COMMENTED', undefined])(
  'AC6 never confirms approval from review state %s',
  async state => {
    const input = await actionInput({ action: 'approve' });
    octokit.pulls.createReview.mockImplementation(async value => {
      writes.push(value);
      return { data: { id: 81, node_id: 'REVIEW_81', state } };
    });
    expect(await facade.act(input)).toMatchObject({
      result: { status: 'unresolved', retry: 'reconcile' },
    });
    expect(await facade.getOperationStatus(input)).toMatchObject({
      result: { status: 'unresolved', retry: 'reconcile' },
    });
    expect(writes).toHaveLength(1);
  }
);

it.each([null, 'unknown'])(
  'AC10 cannot recover a branch update from unavailable target revision %s',
  async targetHeadSha => {
    const input = await actionInput({ action: 'updateBranch' });
    input.revision.targetHeadSha = targetHeadSha;
    pull.head.sha = 'c'.repeat(40);
    expect(await facade.getOperationStatus(input)).toMatchObject({
      result: { status: 'unresolved', retry: 'reconcile' },
    });
    expect(writes).toEqual([]);
    expect(row).toBeNull();
  }
);

it('AC7 fences a head change during branch-update status reads', async () => {
  const input = await actionInput({ action: 'updateBranch' });
  pull.head.sha = 'c'.repeat(40);
  octokit.repos.compareCommits.mockImplementation(async value => {
    if (value.base === headSha) pull.head.sha = 'd'.repeat(40);
    return { data: { merge_base_commit: { sha: value.base } } };
  });
  await expect(facade.getOperationStatus(input)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(writes).toEqual([]);
});

it('AC7 does not confirm an uncertain merge against a different head', async () => {
  const input = await actionInput({ action: 'merge', method: 'squash' });
  octokit.pulls.merge.mockImplementation(async value => {
    writes.push(value);
    throw { status: 503 };
  });
  await expect(facade.act(input)).rejects.toMatchObject({ code: 'CONFLICT' });
  pull.state = 'closed';
  pull.merged = true;
  pull.head.sha = 'c'.repeat(40);
  const pending = structuredClone(row);
  expect(await facade.getOperationStatus(input)).toMatchObject({
    result: { status: 'unresolved', retry: 'reconcile' },
  });
  expect(await facade.act(input)).toMatchObject({
    result: { status: 'unresolved', retry: 'reconcile' },
  });
  expect(row).toEqual(pending);
  expect(await facade.getOperationStatus(input)).toMatchObject({
    result: { status: 'unresolved', retry: 'reconcile' },
  });
  expect(writes).toHaveLength(1);
});

it.each(['head', 'target', 'merge-base'] as const)(
  'AC5 rejects %s drift during file retrieval without relabeling the selection',
  async changed => {
    const overview = await facade.getReview({ review: address });
    const selected = structuredClone(overview.revision);
    octokit.pulls.listFiles.mockImplementation(async () => {
      if (changed === 'head') pull.head.sha = 'c'.repeat(40);
      if (changed === 'target') pull.base.sha = 'c'.repeat(40);
      if (changed === 'merge-base')
        octokit.repos.compareCommits.mockResolvedValue({
          data: { merge_base_commit: { sha: 'c'.repeat(40) } },
        });
      return {
        data: [
          {
            filename: 'file.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            patch: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
      };
    });
    await expect(
      facade.listFiles({ review: overview.identity, revision: selected })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'review_identity_or_revision_changed',
    });
    expect(overview.revision).toEqual(selected);
    expect(writes).toEqual([]);
  }
);

it('AC4 preserves check identity after insertion, reordering, and state changes', async () => {
  let runs = [
    {
      id: 11,
      name: 'build',
      status: 'in_progress',
      conclusion: null,
      app: { name: 'CI' },
      details_url: 'https://github.com/Team/Repo/actions/runs/11',
    },
    {
      id: 22,
      name: 'build',
      status: 'completed',
      conclusion: 'success',
      app: { name: 'CI' },
      details_url: 'https://github.com/Team/Repo/actions/runs/22',
    },
    {
      id: 33,
      name: 'lint',
      status: 'completed',
      conclusion: 'success',
      app: { name: 'Linter' },
      details_url: null,
    },
  ];
  let statuses = [{ context: 'legacy', state: 'pending', target_url: null, updated_at: null }];
  octokit.paginate.mockImplementation(async method =>
    method === octokit.checks.listForRef ? runs : statuses
  );
  const before = (await facade.getReview({ review: address })).checks.checks;
  runs = [
    {
      ...runs[0],
      id: 44,
      name: 'new-check',
      details_url: 'https://github.com/Team/Repo/actions/runs/44',
    },
    runs[2],
    runs[1],
    { ...runs[0], status: 'completed', conclusion: 'success' },
  ];
  statuses = [{ ...statuses[0], state: 'success' }];
  const after = (await facade.getReview({ review: address })).checks.checks;
  for (const check of before)
    expect(after.find(current => current.id === check.id)).toMatchObject({
      name: check.name,
      detailsUrl: check.detailsUrl,
      state: 'passed',
    });
  expect(new Set(after.map(check => check.id)).size).toBe(5);
});

it.each([null, 'https://example.com/shared-check'])(
  'AC4 distinguishes checks with repeated metadata and URL %s',
  async detailsUrl => {
    const run = { name: 'build', status: 'completed', app: null, details_url: detailsUrl };
    let runs = [
      { ...run, id: 11, conclusion: 'failure' },
      { ...run, id: 22, conclusion: 'success' },
    ];
    let statuses = [
      {
        context: 'build',
        state: 'pending',
        target_url: detailsUrl,
        updated_at: '2026-08-30T00:00:00Z',
      },
      {
        context: 'build',
        state: 'success',
        target_url: detailsUrl,
        updated_at: '2026-08-31T00:00:00Z',
      },
    ];
    octokit.paginate.mockImplementation(async method =>
      method === octokit.checks.listForRef ? runs : statuses
    );
    const before = (await facade.getReview({ review: address })).checks.checks;
    expect(new Set(before.map(check => check.id)).size).toBe(3);
    expect(before.map(check => check.state)).toEqual(['failed', 'passed', 'passed']);
    runs = [runs[1], { ...runs[0], conclusion: 'success' }];
    statuses = [...statuses].reverse();
    const after = (await facade.getReview({ review: address })).checks.checks;
    expect(after.map(check => check.id)).toEqual([before[1].id, before[0].id, before[2].id]);
    expect(after.every(check => check.state === 'passed')).toBe(true);
    const legacy = await direct.listChecks({
      owner: address.owner,
      repo: address.repo,
      ref: headSha,
    });
    expect(legacy.checkRuns).toHaveLength(3);
    expect(legacy.checkRuns.every(check => !('id' in check))).toBe(true);
  }
);

it.each(['other-head', 'open', 'same-head'] as const)(
  'AC7 keeps overlapping same-key merge recovery read-only for %s',
  async outcome => {
    const input = await actionInput({ action: 'merge', method: 'squash' });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    gates.admission.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const delayed = facade.act(input).then(
      value => ({ value }),
      error => ({ error })
    );
    await entered.promise;
    octokit.pulls.merge.mockImplementationOnce(async value => {
      writes.push(value);
      throw { status: 503 };
    });
    await expect(facade.act(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(row.status).toBe('reconcile_pending');
    if (outcome !== 'open') {
      pull.state = 'closed';
      pull.merged = true;
    }
    if (outcome === 'other-head') pull.head.sha = 'c'.repeat(40);
    octokit.pulls.merge.mockImplementation(async value => {
      writes.push(value);
      return { data: { merged: true, sha: 'merged' } };
    });
    release.resolve();
    const result = await delayed;
    if (outcome === 'same-head') {
      expect(result).toMatchObject({ value: { result: { status: 'confirmed' } } });
      expect(row.status).toBe('completed');
    } else {
      expect(result).toMatchObject({
        error: { code: 'CONFLICT', message: "Couldn't confirm — check the PR before retrying." },
      });
      expect(row.status).toBe('reconcile_pending');
      expect(await facade.getOperationStatus(input)).toMatchObject({
        result: { status: 'unresolved' },
      });
    }
    expect(writes).toHaveLength(1);
    if (outcome === 'open') {
      // Unscoped legacy callers retain their existing same-head takeover behavior.
      await expect(
        direct.mergePullRequest({
          ...address,
          operationKey,
          method: 'squash',
          deleteBranch: false,
          expectedHeadSha: headSha,
        })
      ).resolves.toMatchObject({ merged: true });
      expect(writes).toHaveLength(2);
    }
  }
);

async function replacementCredential(authorizationId: string, actorId: number) {
  const initial = await getGitHubUserAccessToken(ctx.user.id, { op: 'fetch' });
  if (initial.status !== 'connected') throw new Error('Missing credential fixture');
  const replacement = {
    ...initial,
    credential: {
      ...initial.credential,
      token: 'replacement-fixture',
      authorizationId,
      credentialVersion: 2,
    },
  };
  const replacementOctokit = {
    ...octokit,
    users: { getAuthenticated: async () => ({ data: { id: actorId, login: 'reviewer' } }) },
    pulls: {
      ...octokit.pulls,
      createReview: async (input: unknown) => {
        writes.push({ input, actorId });
        return { data: { id: 81, node_id: 'REVIEW_81', state: 'COMMENTED' } };
      },
    },
  };
  jest
    .mocked(createGitHubPrReviewOctokit)
    .mockImplementation(
      token => (token === replacement.credential.token ? replacementOctokit : octokit) as any
    );
  return { initial, replacement };
}

it.each([
  ['terms', 'authorization'],
  ['terms', 'actor'],
  ['terms', 'same-identity'],
  ['admission', 'authorization'],
  ['admission', 'actor'],
  ['admission', 'same-identity'],
] as const)('AC6 fences %s await against %s replacement', async (stage, change) => {
  const input = await actionInput({ action: 'comment', body: 'Admitted actor only' });
  const { replacement } = await replacementCredential(
    change === 'authorization' ? 'authorization-2' : 'authorization-1',
    change === 'actor' ? 100 : 99
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  gates[stage].mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
  });
  const result = facade.act(input);
  await entered.promise;
  jest.mocked(getGitHubUserAccessToken).mockResolvedValue(replacement);
  release.resolve();
  if (change === 'same-identity') {
    expect(await result).toMatchObject({
      result: { status: 'confirmed', reference: { id: '81' } },
    });
    expect(writes).toEqual([
      {
        input: {
          owner: 'Team',
          repo: 'Repo',
          pull_number: 7,
          event: 'COMMENT',
          commit_id: headSha,
          body: 'Admitted actor only',
        },
        actorId: 99,
      },
    ]);
  } else {
    await expect(result).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'review_identity_or_revision_changed',
    });
    expect(writes).toEqual([]);
    expect(row.status).toBe('failed');
  }
});

it.each(['authorization', 'actor', 'same-identity'] as const)(
  'AC6 fences the rotated credential for %s',
  async change => {
    const input = await actionInput({ action: 'comment', body: 'Rotate safely' });
    const { initial, replacement } = await replacementCredential(
      change === 'authorization' ? 'authorization-2' : 'authorization-1',
      change === 'actor' ? 100 : 99
    );
    jest
      .mocked(getGitHubUserAccessToken)
      .mockImplementation(async (_userId, op) => (op.op === 'rotate' ? replacement : initial));
    octokit.pulls.createReview.mockRejectedValue({ status: 401 });
    const result = facade.act(input);
    if (change === 'same-identity') {
      expect(await result).toMatchObject({
        result: { status: 'confirmed', reference: { id: '81' } },
      });
      expect(writes).toEqual([
        {
          input: {
            owner: 'Team',
            repo: 'Repo',
            pull_number: 7,
            event: 'COMMENT',
            commit_id: headSha,
            body: 'Rotate safely',
          },
          actorId: 99,
        },
      ]);
    } else {
      await expect(result).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'review_identity_or_revision_changed',
      });
      expect(writes).toEqual([]);
      expect(row.status).toBe('failed');
    }
  }
);
