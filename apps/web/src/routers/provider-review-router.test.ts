import { isDeepStrictEqual } from 'node:util';
import { TRPCError } from '@trpc/server';
import type { PlatformIntegration, User } from '@kilocode/db/schema';
import {
  ReviewActionSchema,
  type ReviewOverview,
  type ReviewIntent,
} from '@kilocode/app-shared/provider-review';
import { reviewCapabilityFixtures } from '@kilocode/app-shared/provider-review/fixtures';
import { providerReviewRouter } from './provider-review-router';
import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import { ensureOrganizationAccess } from './organizations/utils';
import { authorizeGitLabReview } from '@/lib/provider-review/gitlab-authorization';
import { authorizeBitbucketReview } from '@/lib/provider-review/bitbucket-authorization';
import * as gitlab from '@/lib/provider-review/gitlab-read';
import * as bitbucket from '@/lib/provider-review/bitbucket-read';
import { runGitLabReviewOperation } from '@/lib/provider-review/gitlab-write';
import { runBitbucketReviewOperation } from '@/lib/provider-review/bitbucket-write';
import { createGitHubReviewBridge } from '@/lib/provider-review/github-bridge';
import {
  GitLabInteractiveError,
  type GitLabInteractiveOperations,
} from '@/lib/integrations/platforms/gitlab/interactive-client';
import { BitbucketInteractiveClientError } from '@/lib/integrations/platforms/bitbucket/interactive-client';

jest.mock('@/lib/trpc/init', () => {
  const t = jest.requireActual('@trpc/server').initTRPC.create();
  return { baseProcedure: t.procedure, createTRPCRouter: t.router };
});
jest.mock('@/lib/drizzle', () => ({ db: {} }));
jest.mock('@/lib/config.server', () => ({}));
jest.mock('@/lib/tokens', () => ({}));
jest.mock('@/lib/integrations/platforms/github/user-token-client', () => ({}));
jest.mock('@/lib/github-pr-review/client', () => ({}));
jest.mock('@/routers/organizations/utils', () => ({ ensureOrganizationAccess: jest.fn() }));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getAllIntegrationsForOwner: jest.fn(),
}));
jest.mock('@/lib/integrations/gitlab-service', () => ({ getGitLabIntegration: jest.fn() }));
jest.mock('@/lib/provider-review/github-bridge', () => ({
  ...jest.requireActual('@/lib/provider-review/github-bridge'),
  createGitHubReviewBridge: jest.fn(),
}));
jest.mock('@/lib/provider-review/gitlab-authorization', () => ({
  ...jest.requireActual('@/lib/provider-review/gitlab-authorization'),
  authorizeGitLabReview: jest.fn(),
}));
jest.mock('@/lib/provider-review/bitbucket-authorization', () => ({
  ...jest.requireActual('@/lib/provider-review/bitbucket-authorization'),
  authorizeBitbucketReview: jest.fn(),
}));
jest.mock('@/lib/provider-review/gitlab-read', () => ({
  getGitLabReview: jest.fn(),
  getGitLabChecks: jest.fn(),
  listGitLabInbox: jest.fn(),
  listGitLabFiles: jest.fn(),
  getGitLabFileContext: jest.fn(),
  listGitLabDiscussions: jest.fn(),
}));
jest.mock('@/lib/provider-review/bitbucket-read', () => ({
  getBitbucketReview: jest.fn(),
  getBitbucketChecks: jest.fn(),
  listBitbucketInbox: jest.fn(),
  listBitbucketFiles: jest.fn(),
  getBitbucketFileContext: jest.fn(),
  listBitbucketDiscussions: jest.fn(),
}));
jest.mock('@/lib/provider-review/gitlab-write', () => ({ runGitLabReviewOperation: jest.fn() }));
jest.mock('@/lib/provider-review/bitbucket-write', () => ({
  runBitbucketReviewOperation: jest.fn(),
}));

const userId = 'oauth/caller';
const orgId = '11111111-1111-4111-8111-111111111111';
const integrationId = '22222222-2222-4222-8222-222222222222';
const repositoryId = '33333333-3333-4333-8333-333333333333';
const workspaceUuid = '44444444-4444-4444-8444-444444444444';
const operationKey = '55555555-5555-4555-8555-555555555555';
const caller = providerReviewRouter.createCaller({ user: { id: userId } as User });
let overview: ReviewOverview;
let integrations: PlatformIntegration[];
let effects: ReviewIntent[];
let statusReads: number;

function fixture(platform: 'gitlab' | 'bitbucket', type: 'user' | 'org') {
  const owner = { type, id: type === 'user' ? userId : orgId };
  const repository =
    platform === 'gitlab'
      ? {
          provider: platform,
          instanceUrl: 'https://gitlab.example/Enterprise',
          repositoryId: '42',
          fullName: 'Group/Sub/Repo',
          defaultBranch: null,
        }
      : {
          provider: platform,
          instanceUrl: 'https://bitbucket.org',
          repositoryId,
          workspaceUuid,
          fullName: 'team/repo',
          defaultBranch: null,
        };
  const identity = {
    repository,
    authorization: { kind: 'ownerIntegration' as const, owner, integrationId },
    reviewId: platform === 'gitlab' ? '77' : '7',
    number: '7',
    canonicalUrl: `${repository.instanceUrl}/${repository.fullName}/${platform === 'gitlab' ? '-/merge_requests' : 'pull-requests'}/7`,
  };
  overview = {
    identity,
    title: 'Authorized review',
    bodyMarkdown: null,
    author: null,
    state: 'closed',
    draft: false,
    revision: {
      headSha: 'a'.repeat(40),
      baseSha: platform === 'gitlab' ? 'b'.repeat(40) : null,
      startSha: platform === 'gitlab' ? 'c'.repeat(40) : null,
      targetHeadSha: platform === 'bitbucket' ? 'b'.repeat(40) : null,
    },
    source: { repository, branch: 'feature' },
    target: { repository, branch: 'trunk' },
    authorization: {
      actor: {
        provider: platform,
        instanceUrl: repository.instanceUrl,
        id: 'provider-actor',
        displayName: 'Integration actor',
        login: null,
        avatarUrl: null,
      },
      credentialKind: platform === 'gitlab' ? 'gitlabPat' : 'bitbucketWorkspaceToken',
      capabilities: reviewCapabilityFixtures(platform),
      writeLimits: { requestMaxBytes: 256000, bodyMaxBytes: null },
    },
    providerState:
      platform === 'gitlab'
        ? {
            provider: platform,
            approvals: { approved: null, required: null, remaining: null, actorIds: [] },
            requestedChanges: {
              actorIds: [],
              blocksMerge: null,
              blockingCapability: reviewCapabilityFixtures(platform).requestChanges,
            },
          }
        : { provider: platform, participants: [], expectedHeadProtection: 'none' },
    checks: { status: 'none', checks: [] },
    counts: { commits: 0, files: 0, additions: 0, deletions: 0 },
    merge: { methods: [], squash: null, autoMerge: null, task: null },
  };
  integrations = [
    {
      id: integrationId,
      platform,
      platform_account_id: workspaceUuid,
      integration_status: 'active',
      suspended_at: null,
      auth_invalid_at: null,
      owned_by_user_id: type === 'user' ? userId : null,
      owned_by_organization_id: type === 'org' ? orgId : null,
      metadata: { gitlab_instance_url: repository.instanceUrl },
      repositories: [
        {
          id: platform === 'gitlab' ? 42 : repositoryId,
          name: 'Repo',
          full_name: repository.fullName,
          private: true,
        },
      ],
    } as PlatformIntegration,
  ];
  return { provider: platform, owner, integrationId, repository };
}
type FixtureAuthorization =
  | Parameters<typeof authorizeGitLabReview>[0]
  | Parameters<typeof authorizeBitbucketReview>[0];

function authorizeFixture(platform: 'gitlab' | 'bitbucket', input: FixtureAuthorization) {
  if (
    platform !== overview.identity.repository.provider ||
    input.userId !== userId ||
    !isDeepStrictEqual(input.authorization, overview.identity.authorization) ||
    ('repository' in input
      ? !isDeepStrictEqual(input.repository, overview.identity.repository)
      : input.instanceUrl !== overview.identity.repository.instanceUrl)
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'fixture_authorization_mismatch' });
  return {
    ...input,
    actor: overview.authorization.actor,
    credentialKind: overview.authorization.credentialKind,
    scopes: ['api', 'pullrequest'],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  effects = [];
  statusReads = 0;
  fixture('gitlab', 'user');
  jest
    .mocked(getAllIntegrationsForOwner)
    .mockImplementation(async owner =>
      integrations.filter(integration =>
        owner.type === 'user'
          ? integration.owned_by_user_id === owner.id
          : integration.owned_by_organization_id === owner.id
      )
    );
  jest.mocked(ensureOrganizationAccess).mockResolvedValue('member');
  jest.mocked(createGitHubReviewBridge).mockImplementation(() => {
    throw new Error('Forbidden GitHub dispatch');
  });
  jest
    .mocked(authorizeGitLabReview)
    .mockImplementation(async input => authorizeFixture('gitlab', input) as any);
  jest
    .mocked(authorizeBitbucketReview)
    .mockImplementation(async input => authorizeFixture('bitbucket', input) as any);
  const read = (
    platform: 'gitlab' | 'bitbucket',
    auth: FixtureAuthorization,
    identity: ReviewIntent['review'],
    revision: ReviewIntent['revision']
  ) => {
    authorizeFixture(platform, auth);
    if (
      !isDeepStrictEqual(identity, overview.identity) ||
      !isDeepStrictEqual(revision, overview.revision)
    )
      throw new TRPCError({ code: 'CONFLICT', message: 'fixture_resource_or_revision_mismatch' });
    return { ...overview, identity, revision };
  };
  jest
    .mocked(gitlab.getGitLabReview)
    .mockImplementation(async (auth, repository, number) =>
      read(
        'gitlab',
        auth,
        { ...overview.identity, repository, number: String(number) },
        overview.revision
      )
    );
  jest
    .mocked(bitbucket.getBitbucketReview)
    .mockImplementation(async (auth, number) =>
      read(
        'bitbucket',
        auth,
        { ...overview.identity, repository: auth.repository, number: String(number) },
        overview.revision
      )
    );
  const inboxFor = (
    platform: 'gitlab' | 'bitbucket',
    auth: FixtureAuthorization,
    repository: ReviewOverview['identity']['repository']
  ) => {
    read(platform, auth, { ...overview.identity, repository }, overview.revision);
    return {
      items: [],
      nextCursor: null,
      scope: { kind: 'repository' as const, actor: overview.authorization.actor, repository },
    };
  };
  jest
    .mocked(gitlab.listGitLabInbox)
    .mockImplementation(async (auth, input) =>
      inboxFor('gitlab', auth, input?.repository as ReviewOverview['identity']['repository'])
    );
  jest
    .mocked(bitbucket.listBitbucketInbox)
    .mockImplementation(async auth => inboxFor('bitbucket', auth, auth.repository));
  for (const [platform, files, discussions, checks, context] of [
    [
      'gitlab',
      gitlab.listGitLabFiles,
      gitlab.listGitLabDiscussions,
      gitlab.getGitLabChecks,
      gitlab.getGitLabFileContext,
    ],
    [
      'bitbucket',
      bitbucket.listBitbucketFiles,
      bitbucket.listBitbucketDiscussions,
      bitbucket.getBitbucketChecks,
      bitbucket.getBitbucketFileContext,
    ],
  ] as const) {
    jest.mocked(files).mockImplementation(async (auth, identity, revision) => {
      read(platform, auth, identity, revision);
      return { items: [], nextCursor: null };
    });
    jest.mocked(discussions).mockImplementation(async (auth, identity) => {
      read(platform, auth, identity, overview.revision);
      return { items: [], nextCursor: null };
    });
    jest
      .mocked(checks)
      .mockImplementation(
        async (auth, identity, revision) => read(platform, auth, identity, revision).checks
      );
    jest.mocked(context).mockImplementation(async (auth, identity, input) => {
      read(platform, auth, identity, input.file.revision);
      return {
        ...input.file,
        path: input.side === 'old' ? 'old.ts' : 'new.ts',
        side: input.side,
        startLine: input.startLine,
        lines: [],
        totalLines: null,
        content: 'binary',
        canonicalUrl: identity.canonicalUrl,
      };
    });
  }
  const run = async (
    platform: 'gitlab' | 'bitbucket',
    auth: FixtureAuthorization,
    request: { intent: ReviewIntent },
    statusOnly?: boolean
  ) => {
    read(platform, auth, request.intent.review, request.intent.revision);
    if (statusOnly) statusReads++;
    else effects.push(request.intent);
    return {
      status: 'unresolved' as const,
      reason: statusOnly ? 'pending_task' : 'provider_receipt',
      reference: {
        provider: platform,
        kind: 'review' as const,
        id: request.intent.review.reviewId,
        url: request.intent.review.canonicalUrl,
      },
      retry: 'reconcile' as const,
      reconciliation: 'required' as const,
    };
  };
  jest
    .mocked(runGitLabReviewOperation)
    .mockImplementation((auth, request, statusOnly) => run('gitlab', auth, request, statusOnly));
  jest
    .mocked(runBitbucketReviewOperation)
    .mockImplementation((auth, request, statusOnly) => run('bitbucket', auth, request, statusOnly));
});
afterEach(() => expect(createGitHubReviewBridge).not.toHaveBeenCalled());

it.each([
  ['gitlab', 'user'],
  ['gitlab', 'org'],
  ['bitbucket', 'org'],
] as const)(
  'AC4–AC7 routes every %s/%s surface with its authorized actor',
  async (platform, owner) => {
    const scope = fixture(platform, owner);
    const review = overview.identity;
    expect(await caller.getAuthorization(scope)).toMatchObject({
      status: 'connected',
      actor: overview.authorization.actor,
    });
    expect(
      await caller.resolveUrl({ url: review.canonicalUrl, owner: scope.owner, integrationId })
    ).toEqual(review);
    expect(await caller.getReview({ review })).toEqual(overview);
    expect(await caller.listInbox(scope)).toMatchObject({
      items: [],
      scope: { actor: overview.authorization.actor, repository: review.repository },
    });
    expect(await caller.listFiles({ review, revision: overview.revision })).toEqual({
      items: [],
      nextCursor: null,
      authorization: overview.authorization,
    });
    expect(await caller.listChecks({ review, revision: overview.revision })).toEqual({
      checks: { status: 'none', checks: [] },
      authorization: overview.authorization,
    });
    expect(await caller.listDiscussions({ review })).toMatchObject({
      items: [],
      authorization: overview.authorization,
    });
    expect(
      await caller.getFileContext({
        review,
        context: {
          file: { oldPath: 'old.ts', newPath: 'new.ts', revision: overview.revision },
          side: 'old',
          startLine: 5,
          lineCount: 10,
        },
      })
    ).toMatchObject({
      content: 'binary',
      path: 'old.ts',
      startLine: 5,
      canonicalUrl: review.canonicalUrl,
      authorization: overview.authorization,
    });
    const actions = ReviewActionSchema.options.filter(action => action !== 'read');
    for (const action of actions) {
      const input = {
        review,
        revision: overview.revision,
        actorId: 'provider-actor',
        operationKey,
        input: { action },
      };
      const reference = {
        provider: platform,
        kind: 'review',
        id: review.reviewId,
        url: review.canonicalUrl,
      };
      expect(await caller.act(input)).toMatchObject({
        result: { status: 'unresolved', reason: 'provider_receipt', reference },
        authorization: overview.authorization,
      });
      expect(await caller.getOperationStatus(input)).toMatchObject({
        result: { status: 'unresolved', reason: 'pending_task', reference },
      });
    }
    expect(statusReads).toBe(17);
    expect(effects).toEqual(
      actions.map(action => ({
        accountId: userId,
        actorId: 'provider-actor',
        review,
        revision: overview.revision,
        input: { action },
      }))
    );
  }
);
it.each([
  ['gitlab', 'user'],
  ['gitlab', 'org'],
  ['bitbucket', 'org'],
] as const)(
  'AC10 resolves old %s/%s references and ignores unrelated saved fields',
  async (platform, type) => {
    const scope = fixture(platform, type);
    const saved = JSON.parse(
      JSON.stringify({
        repository: { provider: platform, fullName: scope.repository.fullName },
        authorization: { kind: 'ownerIntegration', owner: scope.owner },
        number: 7,
        futureField: 'ignored',
      })
    );
    expect((await caller.getReview({ review: saved })).identity).toEqual(overview.identity);
    expect(overview.identity.repository.defaultBranch).toBeNull();
    expect(
      await caller.resolveUrl({ url: overview.identity.canonicalUrl, owner: scope.owner })
    ).toEqual(overview.identity);
  }
);
describe('uncached GitLab project resolution', () => {
  let project: Record<string, unknown>;
  const showProject = jest.fn();

  beforeEach(() => {
    showProject.mockReset().mockImplementation(async (projectId: string | number) => {
      if (projectId !== overview.identity.repository.fullName)
        throw new Error('Unexpected GitLab project lookup');
      return project;
    });
    integrations[0].repositories = null;
    project = {
      id: 42,
      path_with_namespace: 'Group/Sub/Repo',
      web_url: 'https://gitlab.example/Enterprise/Group/Sub/Repo',
      default_branch: null,
    };
    jest.mocked(authorizeGitLabReview).mockImplementation(
      async input =>
        ({
          ...authorizeFixture('gitlab', input),
          instanceUrl: input.instanceUrl,
          client: (projectId?: string) => {
            if (projectId !== overview.identity.repository.fullName)
              throw new Error('Unexpected GitLab client scope');
            return {
              execute: async <T>(operation: (api: GitLabInteractiveOperations) => Promise<T>) => ({
                status: 200 as const,
                headers: {},
                data: await operation({
                  Projects: { show: showProject },
                } as GitLabInteractiveOperations),
              }),
            };
          },
        }) as any
    );
  });

  it.each([
    ['user', false],
    ['org', false],
    ['user', true],
    ['org', true],
  ] as const)('AC4 resolves an accessible %s project with archived=%s', async (owner, archived) => {
    const scope = fixture('gitlab', owner);
    integrations[0].repositories = archived
      ? [{ id: 99, name: 'Other', full_name: 'Group/Other', private: true }]
      : [];
    project.archived = archived;
    project.default_branch = 'release/next';
    overview.identity.repository.defaultBranch = 'release/next';
    expect(
      await caller.resolveUrl({
        url: `${overview.identity.canonicalUrl}/diffs`,
        owner: scope.owner,
        integrationId,
      })
    ).toEqual(overview.identity);
    expect(showProject).toHaveBeenCalledTimes(1);
    expect(showProject).toHaveBeenCalledWith('Group/Sub/Repo');
  });

  it('AC10 resolves an uncached old reference without a numeric project ID', async () => {
    expect(
      await caller.getReview({
        review: {
          repository: { provider: 'gitlab', fullName: 'Group/Sub/Repo' },
          number: 7,
        },
      })
    ).toEqual(overview);
  });

  it('AC4 resolves an uncached repository-scoped empty inbox', async () => {
    expect(
      await caller.listInbox({
        provider: 'gitlab',
        repository: { provider: 'gitlab', fullName: 'Group/Sub/Repo' },
      })
    ).toEqual({
      items: [],
      nextCursor: null,
      scope: {
        kind: 'repository',
        actor: overview.authorization.actor,
        repository: overview.identity.repository,
      },
    });
  });

  it.each([
    { path_with_namespace: 'Group/Other/Repo' },
    {
      path_with_namespace: 'Group/Other/Repo',
      web_url: 'https://gitlab.example/Enterprise/Group/Other/Repo',
    },
    { web_url: 'https://other.example/Enterprise/Group/Sub/Repo' },
    { web_url: 'https://gitlab.example/Other/Group/Sub/Repo' },
    { web_url: 'https://gitlab.example/Enterprise/Group/Other/Repo' },
  ])('AC10 rejects a mismatched lookup identity: %j', async change => {
    Object.assign(project, change);
    await expect(caller.resolveUrl({ url: overview.identity.canonicalUrl })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'not_found',
    });
    expect(gitlab.getGitLabReview).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, '42'])('AC10 rejects a nonnumeric or invalid project ID: %s', async id => {
    project.id = id;
    await expect(caller.resolveUrl({ url: overview.identity.canonicalUrl })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'invalid_response',
    });
    expect(gitlab.getGitLabReview).not.toHaveBeenCalled();
  });

  it.each([
    ['forbidden', 'FORBIDDEN'],
    ['not_found', 'NOT_FOUND'],
    ['reconnect_required', 'PRECONDITION_FAILED'],
  ] as const)('AC4 preserves the project lookup rejection %s', async (code, expected) => {
    showProject.mockRejectedValueOnce(new GitLabInteractiveError(code));
    await expect(caller.resolveUrl({ url: overview.identity.canonicalUrl })).rejects.toMatchObject({
      code: expected,
      message: code,
    });
    expect(gitlab.getGitLabReview).not.toHaveBeenCalled();
  });

  it('AC4 retries a temporary lookup failure with the same pasted URL', async () => {
    showProject.mockRejectedValueOnce(new GitLabInteractiveError('temporarily_unavailable'));
    const input = { url: overview.identity.canonicalUrl };
    await expect(caller.resolveUrl(input)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'temporarily_unavailable',
    });
    await expect(caller.resolveUrl(input)).resolves.toEqual(overview.identity);
  });

  it.each([
    { url: 'https://other.example/Enterprise/Group/Sub/Repo/-/merge_requests/7' },
    { url: 'https://gitlab.example/Other/Group/Sub/Repo/-/merge_requests/7' },
    { url: 'https://gitlab.example/Enterprise/Group/Sub/Repo/issues/7' },
    { owner: { type: 'user' as const, id: 'other' } },
    { integrationId: '66666666-6666-4666-8666-666666666666' },
  ])('AC10 rejects unauthorized uncached URL input: %j', async change => {
    await expect(
      caller.resolveUrl({ url: overview.identity.canonicalUrl, ...change })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(authorizeGitLabReview).not.toHaveBeenCalled();
    expect(showProject).not.toHaveBeenCalled();
  });

  it('AC10 requires an explicit integration when uncached URL resolution is ambiguous', async () => {
    integrations.push({ ...integrations[0], id: '66666666-6666-4666-8666-666666666666' });
    await expect(caller.resolveUrl({ url: overview.identity.canonicalUrl })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'integration_ambiguous',
    });
    expect(authorizeGitLabReview).not.toHaveBeenCalled();
    expect(showProject).not.toHaveBeenCalled();
    await expect(
      caller.resolveUrl({ url: overview.identity.canonicalUrl, integrationId })
    ).resolves.toEqual(overview.identity);
  });
});

it.each(['account', 'review', 'repository', 'url', 'actor'] as const)(
  'AC10 rejects changed %s identity before an effect',
  async field => {
    const input = {
      review: structuredClone(overview.identity),
      revision: overview.revision,
      actorId: 'provider-actor',
      operationKey,
      input: { action: 'comment' as const, body: 'Preserved' },
    };
    if (field === 'account' && input.review.authorization.kind === 'ownerIntegration')
      input.review.authorization.owner = { type: 'user', id: 'other' };
    if (field === 'review') input.review.reviewId = 'another';
    if (field === 'repository') input.review.repository.repositoryId = '43';
    if (field === 'url') input.review.canonicalUrl = 'https://evil.example/review';
    if (field === 'actor') input.actorId = 'other';
    await expect(caller.act(input)).rejects.toBeInstanceOf(TRPCError);
    expect(effects).toEqual([]);
  }
);
it('AC4 preserves read access with unavailable write grants', async () => {
  const scope = fixture('bitbucket', 'org');
  overview.authorization.capabilities.approve.permission = 'forbidden';
  overview.authorization.capabilities.approve.recovery = 'replaceToken';
  jest.mocked(runBitbucketReviewOperation).mockResolvedValue({
    status: 'rejected',
    code: 'insufficient_permissions',
    explanation: 'replaceToken',
    retry: 'never',
    reconciliation: 'not-needed',
  });
  expect((await caller.getReview({ review: overview.identity })).title).toBe('Authorized review');
  expect(await caller.listInbox(scope)).toMatchObject({ items: [] });
  expect(
    await caller.act({
      review: overview.identity,
      revision: overview.revision,
      actorId: 'provider-actor',
      operationKey,
      input: { action: 'approve' },
    })
  ).toMatchObject({
    result: { status: 'rejected', retry: 'never' },
    authorization: {
      capabilities: { approve: { permission: 'forbidden', recovery: 'replaceToken' } },
    },
  });
});
it.each([
  'https://evil.example/Group/Sub/Repo/-/merge_requests/7',
  'https://gitlab.example/Other/Group/Sub/Repo/-/merge_requests/7',
  'https://gitlab.example/Enterprise/Group/Sub/Repo/issues/7',
  'https://gitlab.example/Enterprise/Group/Sub/Repo/-/merge_requests/0',
  'https://user:secret@gitlab.example/Enterprise/Group/Sub/Repo/-/merge_requests/7',
])('AC10 rejects invalid or unauthorized pasted URL %s without provider calls', async url => {
  await expect(caller.resolveUrl({ url })).rejects.toBeInstanceOf(TRPCError);
  expect(authorizeGitLabReview).not.toHaveBeenCalled();
});
it('AC10 rejects ambiguous integrations instead of selecting a different connection', async () => {
  integrations.push({ ...integrations[0], id: '66666666-6666-4666-8666-666666666666' });
  await expect(caller.resolveUrl({ url: overview.identity.canonicalUrl })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'integration_ambiguous',
  });
  expect(authorizeGitLabReview).not.toHaveBeenCalled();
});
it('AC4 rejects Personal Bitbucket and denied organization access', async () => {
  await expect(caller.listInbox({ provider: 'bitbucket' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'bitbucket_requires_organization',
  });
  const scope = fixture('gitlab', 'org');
  jest
    .mocked(ensureOrganizationAccess)
    .mockRejectedValue(new TRPCError({ code: 'UNAUTHORIZED', message: 'membership_required' }));
  await expect(caller.listInbox(scope)).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
    message: 'membership_required',
  });
  expect(authorizeGitLabReview).not.toHaveBeenCalled();
});
it.each([
  ['reconnect_required', 'PRECONDITION_FAILED'],
  ['forbidden', 'FORBIDDEN'],
  ['conflict', 'CONFLICT'],
  ['temporarily_unavailable', 'SERVICE_UNAVAILABLE'],
] as const)('AC4 preserves GitLab recovery class %s', async (code, expected) => {
  jest.mocked(gitlab.getGitLabReview).mockRejectedValue(new GitLabInteractiveError(code));
  await expect(caller.getReview({ review: overview.identity })).rejects.toMatchObject({
    code: expected,
    message: code,
  });
});
it('AC4 preserves a later Bitbucket page failure and cursor without inventing empty success', async () => {
  const scope = fixture('bitbucket', 'org');
  jest
    .mocked(bitbucket.listBitbucketInbox)
    .mockRejectedValue(new BitbucketInteractiveClientError('provider_unavailable'));
  await expect(
    caller.listInbox({ ...scope, cursor: { scopeKey: 'bound-page', token: 'next' } })
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'provider_unavailable' });
});
it('AC6 rejects an oversized serialized write before authorization', async () => {
  await expect(
    caller.act({
      review: overview.identity,
      revision: overview.revision,
      actorId: 'provider-actor',
      operationKey,
      input: { action: 'comment', body: 'x'.repeat(256000) },
    })
  ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  expect(getAllIntegrationsForOwner).not.toHaveBeenCalled();
  expect(effects).toEqual([]);
});
it('AC4 distinguishes no integration from an empty authorized inbox', async () => {
  integrations = [];
  expect(await caller.getAuthorization({ provider: 'gitlab' })).toEqual({
    status: 'not_connected',
    reason: 'not_connected',
    authorization: null,
    actor: null,
  });
});
it.each(['gitlab', 'bitbucket'])(
  'AC10 never downgrades an explicit %s legacy record to GitHub',
  async provider => {
    const saved = JSON.parse(JSON.stringify({ owner: 'Team', repo: 'Repo', number: 7, provider }));
    await expect(caller.getReview({ review: saved })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  }
);
it('AC10 never drops malformed normalized identity through a legacy fallback', async () => {
  const saved = JSON.parse(
    JSON.stringify({
      owner: 'Team',
      repo: 'Repo',
      number: 7,
      repository: { ...overview.identity.repository, provider: 'unknown' },
    })
  );
  await expect(caller.getReview({ review: saved })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});
it('AC6 rejects a foreign provider position at the public boundary', async () => {
  await expect(
    caller.act({
      review: overview.identity,
      actorId: 'provider-actor',
      revision: overview.revision,
      operationKey,
      input: {
        action: 'inlineComment',
        body: 'Keep my selection',
        position: {
          revision: overview.revision,
          oldPath: 'old.ts',
          newPath: 'new.ts',
          side: 'new',
          line: 2,
          native: { provider: 'github' },
        },
      },
    })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(effects).toEqual([]);
});
