jest.mock('@/lib/config.server', () => ({ GIT_TOKEN_SERVICE_API_URL: 'https://broker.example' }));
jest.mock('@/lib/tokens', () => ({
  generateInternalServiceToken: () => 'internal-fixture',
  TOKEN_EXPIRY: { fiveMinutes: '5m' },
}));

import type {
  OwnerIntegrationAuthorization,
  RepositoryIdentity,
} from '@kilocode/app-shared/code-review/repository-identity';
import {
  reviewActionAvailability,
  type ReviewCursor,
  type ReviewIdentity,
  type ReviewRevision,
} from '@kilocode/app-shared/provider-review';
import type {
  BitbucketInteractiveBrokerRequest,
  BitbucketInteractiveMetadata,
} from '@/lib/integrations/platforms/bitbucket/interactive-client';
import {
  createBitbucketInteractiveApi,
  BitbucketInteractiveBrokerRequestSchema,
  type BitbucketInteractiveRequest,
} from '../../../../../services/git-token-service/src/bitbucket-interactive-api';
import { authorizeBitbucketReview } from './bitbucket-authorization';
import {
  getBitbucketChecks,
  getBitbucketFileContext,
  getBitbucketReview,
  listBitbucketDiscussions,
  listBitbucketFiles,
  listBitbucketInbox,
} from './bitbucket-read';

const userId = 'oauth/kilo-user';
const authorization: OwnerIntegrationAuthorization = {
  kind: 'ownerIntegration',
  owner: { type: 'org', id: '11111111-1111-4111-8111-111111111111' },
  integrationId: '22222222-2222-4222-8222-222222222222',
};
const repository: RepositoryIdentity & { provider: 'bitbucket' } = {
  provider: 'bitbucket',
  instanceUrl: 'https://bitbucket.org',
  workspaceUuid: '33333333-3333-4333-8333-333333333333',
  repositoryId: '44444444-4444-4444-8444-444444444444',
  fullName: 'team/repo',
  defaultBranch: 'trunk',
};
const actor = {
  uuid: '{55555555-5555-4555-8555-555555555555}',
  nickname: 'provider-actor',
  display_name: 'Provider Actor',
};
const destination = {
  uuid: `{${repository.repositoryId}}`,
  full_name: repository.fullName,
  workspace: { uuid: `{${repository.workspaceUuid}}`, slug: 'team' },
  mainbranch: { name: 'trunk' },
};
const source = {
  uuid: '{66666666-6666-4666-8666-666666666666}',
  full_name: 'fork/repo',
  workspace: { uuid: '{77777777-7777-4777-8777-777777777777}', slug: 'fork' },
};
const revision: ReviewRevision = {
  headSha: 'a'.repeat(40),
  targetHeadSha: 'c'.repeat(40),
  baseSha: null,
  startSha: null,
};
const fileRevision = { ...revision, baseSha: 'b'.repeat(40) };
const identity: ReviewIdentity = {
  repository,
  authorization,
  number: '7',
  reviewId: '7',
  canonicalUrl: 'https://bitbucket.org/team/repo/pull-requests/7',
};
const providerReview = {
  type: 'pullrequest',
  id: 7,
  title: 'Fork review',
  description: 'Review details',
  state: 'OPEN',
  draft: false,
  updated_on: '2026-08-30T00:00:00Z',
  author: { ...actor, uuid: '{88888888-8888-4888-8888-888888888888}' },
  links: { html: { href: identity.canonicalUrl } },
  source: { repository: source, branch: { name: 'feature' }, commit: { hash: revision.headSha } },
  destination: {
    repository: destination,
    branch: { name: 'release/stable' },
    commit: { hash: revision.targetHeadSha },
  },
  participants: [
    {
      user: actor,
      role: 'REVIEWER',
      state: 'approved',
      approved: true,
      participated_on: '2026-08-30T00:00:00Z',
    },
  ],
};
const apiRoot = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(destination.workspace.uuid)}/${encodeURIComponent(destination.uuid)}`;
const sourceRoot = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(source.workspace.uuid)}/${encodeURIComponent(source.uuid)}`;
const stat = {
  status: 'renamed',
  lines_added: 2,
  lines_removed: 1,
  old: {
    path: 'src/old.ts',
    links: { self: { href: `${apiRoot}/src/${fileRevision.baseSha}/src/old.ts` } },
  },
  new: {
    path: 'src/new.ts',
    links: { self: { href: `${sourceRoot}/src/${revision.headSha}/src/new.ts` } },
  },
};
const patch =
  'diff --git a/src/old.ts b/src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1,2 @@\n-old\n+first\n+second\n';
const comment = {
  id: 1,
  created_on: '2026-08-30T00:00:00Z',
  content: { raw: 'Review comment' },
  user: actor,
  inline: { path: 'src/new.ts', to: 2, start_to: 1 },
  resolution: { type: 'comment_resolution' },
  pullrequest: { id: 7 },
};
const context = {
  file: { oldPath: 'src/old.ts', newPath: 'src/new.ts', revision: fileRevision },
  side: 'new' as const,
  startLine: 2,
  lineCount: 2,
};
let metadata: BitbucketInteractiveMetadata;
let review: typeof providerReview;
let rows: Map<string, unknown>;
let nextRows: Map<string, unknown[]>;
let failures: Map<string, number>;
let nextLinks: Map<string, string>;
let oversized: Set<string>;
let afterResponse: ((operation: string) => void) | undefined;
let sourceText: string;
let metadataOverride: object;
const originalFetch = global.fetch;

beforeEach(() => {
  review = structuredClone(providerReview);
  metadata = {
    actorUserId: userId,
    organizationId: authorization.owner.id,
    integrationId: authorization.integrationId,
    instanceUrl: 'https://bitbucket.org',
    providerActor: {
      credentialKind: 'bitbucketWorkspaceToken',
      workspaceUuid: repository.workspaceUuid,
      workspaceSlug: 'team',
    },
    grants: { scopes: ['repository', 'repository:write', 'pullrequest', 'pullrequest:write'] },
  };
  rows = new Map<string, unknown>([
    ['repository', destination],
    ['pullRequests', [review]],
    ['diffstat', [structuredClone(stat)]],
    ['diff', patch],
    ['commits', [{ hash: revision.headSha }]],
    [`commit:${revision.headSha.slice(0, 12)}`, { hash: revision.headSha }],
    [`commit:${revision.targetHeadSha!.slice(0, 12)}`, { hash: revision.targetHeadSha }],
    ['statuses', []],
    ['restrictions', []],
    [
      'branch',
      {
        name: 'release/stable',
        merge_strategies: [
          'merge_commit',
          'squash',
          'fast_forward',
          'squash_fast_forward',
          'rebase_fast_forward',
          'rebase_merge',
        ],
      },
    ],
    [
      'comments',
      [
        comment,
        {
          id: 2,
          created_on: comment.created_on,
          content: { raw: 'Reply' },
          parent: { id: 1 },
          user: null,
        },
      ],
    ],
  ]);
  nextRows = new Map();
  failures = new Map();
  nextLinks = new Map();
  oversized = new Set();
  afterResponse = undefined;
  sourceText = 'first\nsecond\nthird\n';
  metadataOverride = {};
  global.fetch = jest.fn(async (endpoint, init) => {
    if (
      String(endpoint) !== 'https://broker.example/internal/bitbucket/interactive-review' ||
      new Headers(init?.headers).get('authorization') !== 'Bearer internal-fixture'
    )
      return Response.json({}, { status: 403 });
    const target = JSON.parse(String(init?.body));
    if (
      target.integrationId !== authorization.integrationId ||
      target.workspaceUuid !== repository.workspaceUuid ||
      target.repositoryUuid !== repository.repositoryId ||
      target.repositoryFullName !== repository.fullName
    )
      return Response.json({ success: false, reason: 'repository_mismatch' });
    if (!BitbucketInteractiveBrokerRequestSchema.safeParse(target.request).success)
      return Response.json({ success: false, reason: 'invalid_request' });
    const request: BitbucketInteractiveBrokerRequest = target.request;
    if (
      request.params.path.workspace !== destination.workspace.uuid ||
      request.params.path.repo_slug !== destination.uuid
    )
      return Response.json({ success: false, reason: 'repository_mismatch' });
    const { source: selector, ...native } = request;
    let workspace = destination.workspace.uuid,
      repo = destination.uuid;
    if (selector) {
      if (
        !['file', 'fileMetadata'].includes(request.operation) ||
        selector.pullRequestId !== review.id ||
        `{${selector.workspaceUuid}}` !== review.source.repository.workspace.uuid ||
        `{${selector.repositoryUuid}}` !== review.source.repository.uuid
      )
        return Response.json({ success: false, reason: 'repository_mismatch' });
      if (
        !('commit' in request.params.path) ||
        request.params.path.commit !== revision.headSha ||
        !revision.headSha.startsWith(review.source.commit.hash)
      )
        return Response.json({ success: false, reason: 'conflict' });
      workspace = source.workspace.uuid;
      repo = source.uuid;
    }
    const api = createBitbucketInteractiveApi({
      scope: { kind: 'repository', workspace, repository: repo },
      accessToken: 'provider-secret',
      fetch: async (url, requestInit) => {
        if (requestInit?.method !== 'GET') throw new Error('Read adapter attempted a write');
        const parsed = new URL(String(url));
        const operation = request.operation;
        const resourcePath = decodeURIComponent(parsed.pathname);
        if (
          (operation === 'diff' || operation === 'diffstat') &&
          (!resourcePath.endsWith(`/${operation}/${revision.headSha}..${revision.targetHeadSha}`) ||
            parsed.searchParams.get('topic') !== 'true')
        )
          return Response.json({}, { status: 400 });
        if (
          operation === 'branch' &&
          !resourcePath.endsWith(`/refs/branches/${review.destination.branch.name}`)
        )
          return Response.json({}, { status: 404 });
        if (
          ['statuses', 'comments', 'commits'].includes(operation) &&
          !resourcePath.endsWith(`/pullrequests/${review.id}/${operation}`)
        )
          return Response.json({}, { status: 404 });
        const page = parsed.searchParams.get('page') ?? '1';
        const failure = failures.get(`${operation}:${page}`) ?? failures.get(operation);
        if (failure)
          return Response.json({ error: { message: 'provider-secret' } }, { status: failure });
        if (oversized.has(operation))
          return new Response('partial', {
            headers: { 'content-type': 'text/plain', 'content-length': '1000001' },
          });
        let data =
          operation === 'pullRequest'
            ? review
            : operation === 'commit'
              ? rows.get(`commit:${resourcePath.split('/').at(-1)}`)
              : rows.get(operation);
        if (operation === 'commit' && data === undefined) return Response.json({}, { status: 404 });
        if (operation === 'file' || operation === 'fileMetadata') {
          const path = decodeURIComponent(parsed.pathname);
          const newSide =
            path.includes(source.uuid) && path.includes(`/src/${revision.headSha}/src/new.ts`);
          const oldSide =
            path.includes(destination.uuid) &&
            path.includes(`/src/${fileRevision.baseSha}/src/old.ts`);
          if (!newSide && !oldSide) return Response.json({}, { status: 404 });
          const text = newSide ? sourceText : 'base\ncontext\n';
          data =
            operation === 'file'
              ? (rows.get('file') ?? text)
              : {
                  type: 'commit_file',
                  path: newSide ? 'src/new.ts' : 'src/old.ts',
                  commit: { hash: newSide ? revision.headSha : fileRevision.baseSha },
                  attributes: [],
                  size: Buffer.byteLength(text),
                  ...metadataOverride,
                };
        }
        if (Array.isArray(data)) {
          let values = page === '2' ? (nextRows.get(operation) ?? data) : data;
          if (operation === 'diffstat' && parsed.searchParams.has('path'))
            values = values.filter(
              value =>
                value.old?.path === parsed.searchParams.get('path') ||
                value.new?.path === parsed.searchParams.get('path')
            );
          const next =
            nextLinks.get(operation) ??
            (nextRows.has(operation) && page === '1'
              ? (() => {
                  parsed.searchParams.set('page', '2');
                  return parsed.href;
                })()
              : undefined);
          data = { values, ...(next ? { next } : {}) };
        }
        const response =
          data instanceof Uint8Array
            ? new Response(data, { headers: { 'content-type': 'text/plain' } })
            : typeof data === 'string'
              ? new Response(data, { headers: { 'content-type': 'text/plain' } })
              : Response.json(data);
        afterResponse?.(operation);
        return response;
      },
    });
    try {
      const result = await api.execute({
        ...native,
        params: { ...native.params, path: { ...native.params.path, workspace, repo_slug: repo } },
      } as BitbucketInteractiveRequest);
      return Response.json({ success: true, result, metadata });
    } catch (error) {
      return Response.json({ success: false, reason: (error as { code: string }).code });
    }
  });
});
afterEach(() => {
  global.fetch = originalFetch;
});
const auth = () => authorizeBitbucketReview({ userId, authorization, repository });
function oauth() {
  metadata.providerActor = {
    credentialKind: 'bitbucketOAuth',
    actor: {
      provider: 'bitbucket',
      instanceUrl: 'https://bitbucket.org',
      id: actor.uuid,
      displayName: actor.display_name,
      login: actor.nickname,
      avatarUrl: null,
    },
  };
}

it.each(['workspace', 'oauth'])(
  'AC4 labels a repository inbox with its actual %s principal',
  async kind => {
    if (kind === 'oauth') oauth();
    const result = await listBitbucketInbox(await auth());
    expect(result).toMatchObject({
      items: [{ identity, title: 'Fork review' }],
      scope: {
        kind: 'repository',
        repository,
        actor:
          kind === 'oauth'
            ? { login: 'provider-actor' }
            : { id: `workspace:${repository.workspaceUuid}`, login: null },
      },
    });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  }
);
it('AC4 reads condensed inbox destinations without inventing a workspace', async () => {
  rows.set('pullRequests', [
    {
      ...providerReview,
      destination: { repository: { uuid: destination.uuid, full_name: destination.full_name } },
    },
  ]);
  expect((await listBitbucketInbox(await auth())).items[0].identity.repository).toEqual(repository);
});
it('AC4 normalizes the overview, fork identity, native participant state and all destination strategies', async () => {
  const result = await getBitbucketReview(await auth(), '7');
  expect(result).toMatchObject({
    identity,
    title: 'Fork review',
    bodyMarkdown: 'Review details',
    revision,
    source: {
      repository: {
        repositoryId: source.uuid.slice(1, -1),
        workspaceUuid: source.workspace.uuid.slice(1, -1),
        fullName: 'fork/repo',
        defaultBranch: null,
      },
    },
    target: { branch: 'release/stable' },
    counts: { commits: 1, files: 1, additions: 2, deletions: 1 },
    checks: { status: 'none', checks: [] },
    providerState: {
      provider: 'bitbucket',
      expectedHeadProtection: 'none',
      participants: [
        { actor: { id: actor.uuid.slice(1, -1) }, state: 'approved', role: 'REVIEWER' },
      ],
    },
  });
  expect(result.merge.methods.map(value => value.id)).toEqual([
    'merge_commit',
    'squash',
    'fast_forward',
    'squash_fast_forward',
    'rebase_fast_forward',
    'rebase_merge',
  ]);
  expect(JSON.stringify(result)).not.toContain('provider-secret');
});
it.each(['MERGED', 'DECLINED', 'SUPERSEDED'])('AC4 keeps %s reviews readable', async state => {
  review.state = state;
  const result = await getBitbucketReview(await auth(), '7');
  expect(result.state).toBe(state === 'MERGED' ? 'merged' : 'closed');
  expect(result.counts.files).toBe(1);
  expect(result.authorization.capabilities.merge.restrictions).toContain('review_closed');
});
it.each([
  ['workspace', ['repository', 'pullrequest']],
  ['oauth', ['repository', 'pullrequest']],
  ['workspace', ['repository', 'repository:write', 'pullrequest']],
  ['oauth', ['repository', 'repository:write', 'pullrequest']],
] as const)(
  'AC4 keeps old %s read grants %j and explains each missing write grant',
  async (kind, scopes) => {
    if (kind === 'oauth') oauth();
    metadata.grants.scopes = [...scopes];
    const result = await getBitbucketReview(await auth(), '7');
    expect(result.title).toBe('Fork review');
    for (const action of [
      'read',
      'comment',
      'inlineComment',
      'reply',
      'resolveThread',
      'reopenThread',
    ] as const)
      expect(reviewActionAvailability(result.authorization.capabilities[action])).toBe('available');
    for (const action of [
      'approve',
      'unapprove',
      'requestChanges',
      'removeChangeRequest',
      'submitReview',
      'merge',
    ] as const)
      expect(result.authorization.capabilities[action]).toMatchObject({
        support: 'supported',
        permission: 'forbidden',
        explanation: 'missing_scope:pullrequest:write',
        recovery: kind === 'oauth' ? 'reconnect' : 'replaceToken',
      });
  }
);
it.each(['workspace', 'oauth'])(
  'AC6 uses implied %s pullrequest permission for comment capabilities',
  async kind => {
    if (kind === 'oauth') oauth();
    metadata.grants.scopes = ['pullrequest:write'];
    const { capabilities } = (await getBitbucketReview(await auth(), '7')).authorization;
    for (const action of [
      'read',
      'comment',
      'inlineComment',
      'reply',
      'resolveThread',
      'reopenThread',
    ] as const) {
      expect(reviewActionAvailability(capabilities[action])).toBe('available');
      expect(capabilities[action]).toMatchObject({ explanation: '', recovery: 'none' });
    }
    expect(capabilities.deleteBranch).toMatchObject({
      permission: 'forbidden',
      explanation: 'missing_scope:repository:write',
      recovery: kind === 'oauth' ? 'reconnect' : 'replaceToken',
    });
  }
);
it.each([
  ['workspace', false, 'available'],
  ['oauth', false, 'available'],
  ['workspace', true, 'restricted'],
  ['oauth', true, 'restricted'],
] as const)(
  'AC6 uses implied %s discussion permission with deleted=%s as %s',
  async (kind, deleted, availability) => {
    if (kind === 'oauth') oauth();
    metadata.grants.scopes = ['pullrequest:write'];
    rows.set('comments', [{ ...comment, deleted }]);
    const result = await listBitbucketDiscussions(await auth(), identity);
    for (const action of ['resolveThread', 'reopenThread'] as const) {
      const capability = result.items[0].capabilities[action]!;
      expect(reviewActionAvailability(capability)).toBe(availability);
      expect(capability).toMatchObject({
        permission: 'allowed',
        restrictions: deleted ? ['comment_deleted'] : [],
        recovery: 'none',
      });
    }
  }
);
it.each([
  ['workspace', []],
  ['oauth', []],
  ['workspace', ['repository:write']],
  ['oauth', ['repository:write']],
] as const)(
  'AC6 denies missing %s review grants with raw scopes %j and retains recovery',
  async (kind, scopes) => {
    if (kind === 'oauth') oauth();
    metadata.grants.scopes = [...scopes];
    const selected = await auth();
    const { capabilities } = (await getBitbucketReview(selected, '7')).authorization;
    expect(reviewActionAvailability(capabilities.read)).toBe('available');
    for (const action of [
      'comment',
      'inlineComment',
      'reply',
      'resolveThread',
      'reopenThread',
      'approve',
      'unapprove',
      'requestChanges',
      'removeChangeRequest',
      'submitReview',
      'merge',
    ] as const) {
      expect(reviewActionAvailability(capabilities[action])).toBe('forbidden');
      expect(capabilities[action]).toMatchObject({
        permission: 'forbidden',
        recovery: kind === 'oauth' ? 'reconnect' : 'replaceToken',
      });
    }
    expect(capabilities.comment.explanation).toBe('missing_scope:pullrequest');
    expect(capabilities.merge.explanation).toBe('missing_scope:pullrequest:write');
    if (scopes.length === 0)
      expect(capabilities.deleteBranch).toMatchObject({
        permission: 'forbidden',
        explanation: 'missing_scope:repository:write',
        recovery: kind === 'oauth' ? 'reconnect' : 'replaceToken',
      });
    const discussions = await listBitbucketDiscussions(selected, identity);
    for (const action of ['resolveThread', 'reopenThread'] as const)
      expect(discussions.items[0].capabilities[action]).toMatchObject({
        permission: 'forbidden',
        explanation: 'missing_scope:pullrequest',
        recovery: kind === 'oauth' ? 'reconnect' : 'replaceToken',
      });
  }
);
it('AC6 supports approvals, withdrawal, change requests and resolution when grants permit', async () => {
  oauth();
  metadata.grants.scopes = ['pullrequest:write'];
  let result = await getBitbucketReview(await auth(), '7');
  for (const action of [
    'approve',
    'unapprove',
    'requestChanges',
    'resolveThread',
    'reopenThread',
  ] as const)
    expect(reviewActionAvailability(result.authorization.capabilities[action])).toBe('available');
  review.participants[0].state = 'changes_requested';
  review.participants[0].approved = false;
  result = await getBitbucketReview(await auth(), '7');
  expect(reviewActionAvailability(result.authorization.capabilities.removeChangeRequest)).toBe(
    'available'
  );
  expect(result.providerState).toMatchObject({ participants: [{ state: 'changes_requested' }] });
  expect(result.authorization.capabilities.unapprove.restrictions).toContain('not_approved');
  expect(result.authorization.capabilities.merge).toMatchObject({
    permission: 'unknown',
    explanation: 'repository_merge_permission_unknown',
  });
});
it('AC6 never derives atomic guards or API support from a successful read', async () => {
  metadata.grants.scopes = ['pullrequest:write'];
  const result = await getBitbucketReview(await auth(), '7');
  for (const [action, issue] of [
    ['enableAutoMerge', '22062'],
    ['disableAutoMerge', '22062'],
    ['updateBranch', '20489'],
    ['addReaction', '21346'],
    ['removeReaction', '21346'],
  ] as const) {
    const capability = result.authorization.capabilities[action];
    expect(reviewActionAvailability(capability)).toBe('unsupported');
    expect(capability.evidenceUrl).toBe(`https://jira.atlassian.com/browse/BCLOUD-${issue}`);
    expect(capability.explanation).not.toBe('');
  }
  expect(result.authorization.capabilities.merge.expectedHeadProtection).toBe('none');
  expect(result.authorization.capabilities.inlineComment.expectedHeadProtection).toBe('none');
  expect(result.authorization.capabilities.deleteBranch.restrictions).toContain(
    'fork_source_requires_separate_authorization'
  );
});
it.each([{ strategies: [] }, { strategies: ['rebase_merge', 'future_strategy'] }])(
  'AC4 retains the destination strategy set $strategies',
  async ({ strategies }) => {
    rows.set('branch', { name: 'release/stable', merge_strategies: strategies });
    const result = await getBitbucketReview(await auth(), '7');
    expect(result.merge.methods.map(value => value.id)).toEqual(strategies);
    expect(
      result.authorization.capabilities.merge.restrictions.includes('merge_strategies_unavailable')
    ).toBe(strategies.length === 0);
  }
);
it.each([false, true])('AC4 separates advisory and enforced checks: %s', async enforced => {
  rows.set('restrictions', [
    { kind: 'require_passing_builds_to_merge', pattern: 'release/*', value: 1 },
    { kind: 'require_approvals_to_merge', pattern: 'main', value: 100 },
    ...(enforced ? [{ kind: 'enforce_merge_checks', pattern: 'release/*' }] : []),
  ]);
  const result = await getBitbucketReview(await auth(), '7');
  expect(
    result.authorization.capabilities.merge.restrictions.includes('passing_builds_required')
  ).toBe(enforced);
  expect(result.authorization.capabilities.merge.restrictions).not.toContain('approvals_required');
  expect(result.authorization.capabilities.merge.explanation).toContain(
    enforced ? 'enforced_merge_checks' : 'advisory_merge_checks'
  );
  expect(result.checks).toEqual({ status: 'none', checks: [] });
});
it('AC4 clears a satisfied enforced build policy without inventing per-check requirements', async () => {
  rows.set('restrictions', [
    { kind: 'enforce_merge_checks', pattern: '*' },
    { kind: 'require_passing_builds_to_merge', pattern: '*', value: 1 },
  ]);
  rows.set('statuses', [
    { key: 'build', name: 'Build', state: 'SUCCESSFUL', url: 'https://ci.example/build' },
  ]);
  const result = await getBitbucketReview(await auth(), '7');
  expect(result.authorization.capabilities.merge.restrictions).toEqual([]);
  expect(result.checks).toMatchObject({
    status: 'reported',
    checks: [{ id: 'build', state: 'passed', required: null }],
  });
});
it('AC4 separates actor restrictions, branching-model uncertainty and unmet approval policy', async () => {
  rows.set('restrictions', [
    { kind: 'restrict_merges', pattern: '*', users: [], groups: [] },
    { kind: 'require_no_changes_requested', branch_match_kind: 'branching_model', pattern: '' },
    { kind: 'enforce_merge_checks', pattern: '*' },
    { kind: 'require_approvals_to_merge', pattern: '*', value: 2 },
  ]);
  const result = await getBitbucketReview(await auth(), '7');
  expect(result.authorization.capabilities.merge.restrictions).toEqual(
    expect.arrayContaining([
      'actor_merge_restricted',
      'branching_model_restrictions_unknown',
      'approvals_required',
    ])
  );
});
it.each(['branch', 'restrictions'])(
  'AC4 keeps inaccessible %s policy distinct from supported merge',
  async operation => {
    failures.set(operation, 403);
    const result = await getBitbucketReview(await auth(), '7');
    expect(result.title).toBe('Fork review');
    expect(result.authorization.capabilities.merge.restrictions).toContain(
      operation === 'branch' ? 'merge_strategies_unavailable' : 'merge_restrictions_unavailable'
    );
  }
);
it.each([
  ['INPROGRESS', 'running'],
  ['FAILED', 'failed'],
  ['STOPPED', 'cancelled'],
  ['UNKNOWN', 'unknown'],
])('AC4 maps check state %s honestly', async (state, expected) => {
  rows.set('statuses', [{ key: 'build', state, url: 'javascript:unsafe' }]);
  expect(await getBitbucketChecks(await auth(), identity, revision)).toMatchObject({
    status: 'reported',
    checks: [{ state: expected, detailsUrl: null, required: null }],
  });
});
it.each([
  [403, 'unavailable'],
  [503, 'provider_unavailable'],
] as const)('AC4 distinguishes check failure %s from no checks', async (status, expected) => {
  failures.set('statuses', status);
  if (status === 403)
    expect(await getBitbucketChecks(await auth(), identity)).toEqual({
      status: 'unavailable',
      explanation: 'insufficient_permissions',
    });
  else
    await expect(getBitbucketChecks(await auth(), identity)).rejects.toMatchObject({
      code: expected,
    });
});
it('AC4–AC6 keeps empty inbox, files, checks and discussion separate', async () => {
  for (const key of ['pullRequests', 'diffstat', 'comments']) rows.set(key, []);
  const selected = await auth();
  expect(await listBitbucketInbox(selected)).toMatchObject({
    items: [],
    nextCursor: null,
    scope: { kind: 'repository' },
  });
  expect(await listBitbucketFiles(selected, identity, revision)).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(await listBitbucketDiscussions(selected, identity)).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(await getBitbucketChecks(selected, identity)).toEqual({ status: 'none', checks: [] });
  expect((await getBitbucketReview(selected, '7')).counts).toEqual({
    files: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
  });
});
it('AC5 retains both rename paths, the merge-base entry, patch and exact provider link', async () => {
  expect((await listBitbucketFiles(await auth(), identity, revision)).items).toMatchObject([
    {
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
      status: 'renamed',
      revision: fileRevision,
      patch,
      additions: 2,
      deletions: 1,
      canonicalUrl: `https://bitbucket.org/fork/repo/src/${revision.headSha}/src/new.ts`,
    },
  ]);
});
it.each([
  ['added', null, stat.new, null],
  ['removed', stat.old, null, fileRevision.baseSha],
] as const)('AC5 retains absent sides for %s files', async (status, old, next, baseSha) => {
  rows.set('diffstat', [{ ...stat, status, old, new: next }]);
  const result = (await listBitbucketFiles(await auth(), identity, revision)).items[0];
  expect(result).toMatchObject({
    oldPath: old?.path ?? null,
    newPath: next?.path ?? null,
    status: status === 'removed' ? 'deleted' : 'added',
    revision: { ...revision, baseSha },
  });
});
it('AC5 preserves unknown line counts beside confirmed numeric counts', async () => {
  rows.set('diffstat', [{ ...stat, lines_added: null, lines_removed: undefined }]);
  const selected = await auth();
  expect((await listBitbucketFiles(selected, identity, revision)).items[0]).toMatchObject({
    additions: null,
    deletions: null,
    patch,
  });
  expect((await getBitbucketReview(selected, '7')).counts).toMatchObject({
    files: 1,
    additions: null,
    deletions: null,
  });
});
it.each(['binary', 'truncated', 'unavailable'] as const)(
  'AC5 explains %s patches without false empty files',
  async content => {
    if (content === 'binary')
      rows.set('diff', 'Binary files a/src/old.ts and b/src/new.ts differ\n');
    if (content === 'truncated') rows.set('diff', '@@ -1 +1,2 @@\n-old\n+first\n');
    if (content === 'unavailable') {
      rows.set('diff', '');
      rows.set('diffstat', [{ ...stat, lines_added: null, lines_removed: null }]);
    }
    const result = (await listBitbucketFiles(await auth(), identity, revision)).items[0];
    expect(result.content).toBe(content);
    expect(result.canonicalUrl).toContain(`/src/${revision.headSha}/src/new.ts`);
    if (content !== 'unavailable') expect(result.patch).toBeNull();
  }
);
it('AC5 turns bounded diff failure into truncated metadata, not a lost file', async () => {
  oversized.add('diff');
  expect((await listBitbucketFiles(await auth(), identity, revision)).items[0]).toMatchObject({
    content: 'truncated',
    patch: null,
    additions: 2,
    deletions: 1,
  });
});
it('AC5 reads fork source context and old merge-base context through destination authorization', async () => {
  const selected = await auth();
  expect(await getBitbucketFileContext(selected, identity, context)).toMatchObject({
    revision: fileRevision,
    content: 'available',
    path: 'src/new.ts',
    side: 'new',
    lines: ['second', 'third'],
    totalLines: 3,
  });
  expect(
    await getBitbucketFileContext(selected, identity, { ...context, side: 'old', startLine: 1 })
  ).toMatchObject({
    revision: fileRevision,
    content: 'available',
    path: 'src/old.ts',
    side: 'old',
    lines: ['base', 'context'],
    canonicalUrl: `https://bitbucket.org/team/repo/src/${fileRevision.baseSha}/src/old.ts`,
  });
});
it('AC5 resolves abbreviated review hashes before immutable source reads', async () => {
  review.source.commit.hash = revision.headSha.slice(0, 12);
  review.destination.commit.hash = revision.targetHeadSha!.slice(0, 12);
  const selected = await auth();
  expect((await getBitbucketReview(selected, '7')).revision).toEqual(revision);
  expect((await getBitbucketFileContext(selected, identity, context)).lines).toEqual([
    'second',
    'third',
  ]);
});
it.each(['headSha', 'targetHeadSha', 'baseSha'] as const)(
  'AC5 rejects stale %s without retargeting context',
  async field => {
    await expect(
      getBitbucketFileContext(await auth(), identity, {
        ...context,
        file: { ...context.file, revision: { ...fileRevision, [field]: 'd'.repeat(40) } },
      })
    ).rejects.toMatchObject({ code: 'conflict' });
  }
);
it.each(['diff', 'file', 'statuses'] as const)(
  'AC4–AC5 rejects head drift during %s reads',
  async operation => {
    afterResponse = current => {
      if (current === operation) review.source.commit.hash = 'd'.repeat(40);
    };
    const selected = await auth();
    const result =
      operation === 'diff'
        ? listBitbucketFiles(selected, identity, revision)
        : operation === 'file'
          ? getBitbucketFileContext(selected, identity, context)
          : getBitbucketChecks(selected, identity);
    await expect(result).rejects.toMatchObject({ code: 'conflict' });
  }
);
it.each([
  [{ attributes: ['binary'] }, 'binary'],
  [{ size: 1000001 }, 'truncated'],
  [{ size: 100 }, 'truncated'],
  [{ type: 'commit_directory' }, 'unavailable'],
  [{ attributes: ['link'] }, 'unavailable'],
] as const)('AC5 explains unavailable context metadata %j', async (change, content) => {
  metadataOverride = change;
  expect(await getBitbucketFileContext(await auth(), identity, context)).toMatchObject({
    content,
    lines: [],
    totalLines: null,
    canonicalUrl: `https://bitbucket.org/fork/repo/src/${revision.headSha}/src/new.ts`,
  });
});
it('AC5 preserves an empty source file as available', async () => {
  sourceText = '';
  expect(await getBitbucketFileContext(await auth(), identity, context)).toMatchObject({
    content: 'available',
    lines: [],
    totalLines: 0,
  });
});
it.each([{ path: 'wrong.ts' }, { commit: { hash: 'd'.repeat(40) } }])(
  'AC5 rejects mismatched context metadata %j',
  async change => {
    metadataOverride = change;
    await expect(getBitbucketFileContext(await auth(), identity, context)).rejects.toMatchObject({
      code: 'conflict',
    });
  }
);
it.each([0, 501])('AC5 rejects invalid context length %s', async lineCount => {
  await expect(
    getBitbucketFileContext(await auth(), identity, { ...context, lineCount })
  ).rejects.toMatchObject({ code: 'invalid_request' });
});
it.each([403, 404, 503])(
  'AC5 distinguishes context denial and retryable failure %s',
  async status => {
    failures.set('fileMetadata', status);
    const selected = await auth();
    if (status !== 503)
      expect(await getBitbucketFileContext(selected, identity, context)).toMatchObject({
        content: 'unavailable',
        lines: [],
        totalLines: null,
      });
    else {
      await expect(getBitbucketFileContext(selected, identity, context)).rejects.toMatchObject({
        code: 'provider_unavailable',
      });
      failures.clear();
      expect((await getBitbucketFileContext(selected, identity, context)).lines).toEqual([
        'second',
        'third',
      ]);
    }
  }
);
it('AC5 never replaces a missing old revision with the destination head', async () => {
  rows.set('diffstat', [{ ...stat, old: { path: 'src/old.ts' } }]);
  expect(
    await getBitbucketFileContext(await auth(), identity, {
      ...context,
      side: 'old',
      file: { ...context.file, revision },
    })
  ).toMatchObject({
    content: 'unavailable',
    totalLines: null,
    canonicalUrl: `${identity.canonicalUrl}/diff`,
  });
});
it.each(['inbox', 'files', 'discussions'] as const)(
  'AC4–AC6 retains a loaded %s page across failure and retry',
  async surface => {
    const operation =
      surface === 'inbox' ? 'pullRequests' : surface === 'files' ? 'diffstat' : 'comments';
    if (surface === 'inbox')
      nextRows.set(operation, [
        {
          ...providerReview,
          id: 8,
          title: 'Later review',
          links: { html: { href: identity.canonicalUrl.replace('/7', '/8') } },
        },
      ]);
    if (surface === 'files')
      nextRows.set(operation, [{ ...stat, old: null, new: { path: 'later.ts' } }]);
    if (surface === 'discussions') {
      rows.set(
        operation,
        Array.from({ length: 25 }, (_, index) => ({ ...comment, id: index + 1 }))
      );
      nextRows.set(operation, [{ ...comment, id: 26 }]);
    }
    const selected = await auth();
    const read = (cursor?: ReviewCursor | null) =>
      surface === 'inbox'
        ? listBitbucketInbox(selected, { cursor })
        : surface === 'files'
          ? listBitbucketFiles(selected, identity, revision, cursor)
          : listBitbucketDiscussions(selected, identity, cursor);
    const first = await read();
    const retained = JSON.stringify(first);
    expect(first.nextCursor).not.toBeNull();
    failures.set(`${operation}:2`, 503);
    await expect(read(first.nextCursor)).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(JSON.stringify(first)).toBe(retained);
    failures.clear();
    const second = await read(first.nextCursor);
    expect(second.nextCursor).toBeNull();
    expect(second.items).toHaveLength(1);
  }
);
it('AC4 rejects a cursor from another actor, account, grant, state or surface', async () => {
  nextRows.set('pullRequests', [providerReview]);
  const selected = await auth();
  const first = await listBitbucketInbox(selected);
  for (const changed of [
    { ...selected, actor: { ...selected.actor, id: 'other' } },
    { ...selected, userId: 'other' },
    { ...selected, scopes: ['pullrequest'] as typeof selected.scopes },
  ])
    await expect(listBitbucketInbox(changed, { cursor: first.nextCursor })).rejects.toMatchObject({
      code: 'invalid_pagination',
    });
  await expect(
    listBitbucketInbox(selected, { state: 'MERGED', cursor: first.nextCursor })
  ).rejects.toMatchObject({ code: 'invalid_pagination' });
  await expect(
    listBitbucketFiles(selected, identity, revision, first.nextCursor)
  ).rejects.toMatchObject({ code: 'invalid_pagination' });
});
it.each([
  'https://evil.example/page',
  `${apiRoot}/pullrequests/8/comments?pagelen=50&page=2`,
  `${apiRoot}/pullrequests?pagelen=50&state=MERGED&page=2`,
])('AC4 rejects unsafe provider pagination %s', async url => {
  nextLinks.set('pullRequests', url);
  await expect(listBitbucketInbox(await auth())).rejects.toMatchObject({
    code: 'invalid_pagination',
  });
});
it('AC4 rejects a foreign-origin caller cursor even with its correct scope key', async () => {
  nextRows.set('pullRequests', [providerReview]);
  const selected = await auth();
  const first = await listBitbucketInbox(selected);
  await expect(
    listBitbucketInbox(selected, {
      cursor: {
        ...first.nextCursor!,
        token: JSON.stringify({ count: 1, next: 'https://evil.example/page' }),
      },
    })
  ).rejects.toMatchObject({ code: 'invalid_pagination' });
});
it.each(['statuses', 'commits', 'diffstat'] as const)(
  'AC4 never reports an incomplete %s aggregate as empty or complete',
  async operation => {
    nextRows.set(operation, []);
    failures.set(`${operation}:2`, 503);
    await expect(getBitbucketReview(await auth(), '7')).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  }
);
it('AC6 groups replies across native pages and does not invent comment-time revisions', async () => {
  rows.set('comments', [comment]);
  nextRows.set('comments', [
    { id: 2, created_on: comment.created_on, content: { raw: 'Later reply' }, parent: { id: 1 } },
  ]);
  const result = await listBitbucketDiscussions(await auth(), identity);
  expect(result).toMatchObject({
    nextCursor: null,
    items: [
      {
        id: '1',
        subjectType: 'line',
        resolved: true,
        outdated: null,
        position: null,
        file: null,
        comments: {
          nextCursor: null,
          items: [
            { bodyMarkdown: 'Review comment', author: { id: actor.uuid.slice(1, -1) } },
            { bodyMarkdown: 'Later reply', author: null },
          ],
        },
      },
    ],
  });
  expect(result.items[0].reference.url).toContain('comment-1');
  expect(reviewActionAvailability(result.items[0].capabilities.resolveThread!)).toBe('available');
});
it('AC6 keeps deleted actors and unresolved conversations distinct', async () => {
  rows.set('comments', [
    { ...comment, inline: null, resolution: null, user: null },
    { ...comment, id: 2, deleted: true, parent: { id: 1 } },
  ]);
  const result = await listBitbucketDiscussions(await auth(), identity);
  expect(result.items[0]).toMatchObject({
    subjectType: 'conversation',
    resolved: false,
    outdated: null,
    comments: {
      items: [
        { author: null, bodyMarkdown: 'Review comment' },
        { author: null, bodyMarkdown: '' },
      ],
    },
  });
});
it.each(['orphan', 'cycle', 'duplicate', 'wrong-review'] as const)(
  'AC6 rejects %s comment data instead of losing discussion',
  async defect => {
    rows.set(
      'comments',
      defect === 'orphan'
        ? [{ ...comment, parent: { id: 99 } }]
        : defect === 'cycle'
          ? [{ ...comment, parent: { id: 1 } }]
          : defect === 'duplicate'
            ? [comment, comment]
            : [{ ...comment, pullrequest: { id: 8 } }]
    );
    await expect(listBitbucketDiscussions(await auth(), identity)).rejects.toMatchObject({
      code: defect === 'wrong-review' ? 'repository_mismatch' : 'invalid_response',
    });
  }
);
it.each([
  { reviewId: '8' },
  { number: '8' },
  { canonicalUrl: 'https://other.example/review' },
  { authorization: { ...authorization, integrationId: '99999999-9999-4999-8999-999999999999' } },
  {
    authorization: {
      ...authorization,
      owner: { type: 'org', id: '99999999-9999-4999-8999-999999999999' },
    },
  },
  { repository: { ...repository, repositoryId: '99999999-9999-4999-8999-999999999999' } },
  { repository: { ...repository, workspaceUuid: '99999999-9999-4999-8999-999999999999' } },
])('AC4–AC6 rejects a substituted review identity %j', async change => {
  await expect(
    listBitbucketDiscussions(await auth(), { ...identity, ...change } as ReviewIdentity)
  ).rejects.toMatchObject({ code: 'repository_mismatch' });
});
it.each(['id', 'repository', 'workspace'] as const)(
  'AC4 rejects live review %s collisions',
  async field => {
    if (field === 'id') review.id = 8;
    if (field === 'repository')
      review.destination.repository.uuid = '{99999999-9999-4999-8999-999999999999}';
    if (field === 'workspace')
      review.destination.repository.workspace.uuid = '{99999999-9999-4999-8999-999999999999}';
    await expect(getBitbucketReview(await auth(), '7')).rejects.toMatchObject({
      code: field === 'workspace' ? 'workspace_mismatch' : 'repository_mismatch',
    });
  }
);
it('AC4 stops revoked authorization during a read without exporting stale data', async () => {
  const selected = await auth();
  failures.set('pullRequest', 401);
  const error = await getBitbucketChecks(selected, identity).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'authentication_rejected' });
  expect(JSON.stringify(error)).not.toContain('provider-secret');
});
it('AC6 does not falsely claim a workspace token has no approval or change request', async () => {
  const result = await getBitbucketReview(await auth(), '7');
  for (const action of ['unapprove', 'removeChangeRequest'] as const) {
    expect(reviewActionAvailability(result.authorization.capabilities[action])).toBe('available');
    expect(result.authorization.capabilities[action].explanation).toBe('participant_actor_unknown');
  }
});
it.each([0, 1])(
  'AC4 uses the documented open task count %s for enforced checks',
  async task_count => {
    Object.assign(review, { task_count });
    rows.set('restrictions', [
      { kind: 'enforce_merge_checks', pattern: '*' },
      { kind: 'require_tasks_to_be_completed', pattern: '*' },
    ]);
    const result = await getBitbucketReview(await auth(), '7');
    expect(result.authorization.capabilities.merge.restrictions).toEqual(
      task_count === 0 ? [] : ['open_tasks']
    );
  }
);
it.each(['repository', 'workspace', 'branch'] as const)(
  'AC5 rejects a file cursor after source %s replacement at the same head',
  async field => {
    nextRows.set('diffstat', []);
    const selected = await auth();
    const first = await listBitbucketFiles(selected, identity, revision);
    if (field === 'repository')
      review.source.repository.uuid = '{99999999-9999-4999-8999-999999999999}';
    if (field === 'workspace')
      review.source.repository.workspace.uuid = '{99999999-9999-4999-8999-999999999999}';
    if (field === 'branch') review.source.branch.name = 'other-branch';
    await expect(
      listBitbucketFiles(selected, identity, revision, first.nextCursor)
    ).rejects.toMatchObject({ code: 'invalid_pagination' });
  }
);
it('AC6 rejects a discussion cursor after source replacement at the same head', async () => {
  rows.set(
    'comments',
    Array.from({ length: 26 }, (_, index) => ({ ...comment, id: index + 1 }))
  );
  const selected = await auth();
  const first = await listBitbucketDiscussions(selected, identity);
  review.source.repository.uuid = '{99999999-9999-4999-8999-999999999999}';
  await expect(
    listBitbucketDiscussions(selected, identity, first.nextCursor)
  ).rejects.toMatchObject({ code: 'invalid_pagination' });
});
it('AC6 rejects missing live comment content instead of fabricating an empty comment', async () => {
  rows.set('comments', [{ ...comment, content: undefined }]);
  await expect(listBitbucketDiscussions(await auth(), identity)).rejects.toMatchObject({
    code: 'invalid_response',
  });
});
it('AC5 reads immutable diffstat commit fields without requiring optional links', async () => {
  rows.set('diffstat', [
    {
      ...stat,
      old: { path: 'src/old.ts', commit: { hash: fileRevision.baseSha } },
      new: { path: 'src/new.ts', commit: { hash: revision.headSha } },
    },
  ]);
  const selected = await auth();
  expect((await listBitbucketFiles(selected, identity, revision)).items[0].revision).toEqual(
    fileRevision
  );
  expect((await getBitbucketFileContext(selected, identity, context)).lines).toEqual([
    'second',
    'third',
  ]);
});
it.each([
  'https://evil.example/src/old.ts',
  `${apiRoot.replace(encodeURIComponent(destination.uuid), 'other')}/src/${fileRevision.baseSha}/src/old.ts`,
  `${apiRoot}/src/${fileRevision.baseSha}/wrong.ts`,
  `${apiRoot}/src/main/src/old.ts`,
])('AC5 rejects an unsafe or mutable old entry link %s', async href => {
  rows.set('diffstat', [{ ...stat, old: { path: 'src/old.ts', links: { self: { href } } } }]);
  await expect(listBitbucketFiles(await auth(), identity, revision)).rejects.toMatchObject({
    code: 'invalid_response',
  });
});
it('AC6 bounds combined comment pages without silently dropping replies', async () => {
  rows.set('comments', [{ ...comment, content: { raw: 'x'.repeat(550000) } }]);
  nextRows.set('comments', [
    { ...comment, id: 2, parent: { id: 1 }, content: { raw: 'y'.repeat(550000) } },
  ]);
  await expect(listBitbucketDiscussions(await auth(), identity)).rejects.toMatchObject({
    code: 'response_too_large',
  });
});
it.each(['diff', 'file'] as const)(
  'AC5 retains the exact provider link when %s bytes are not UTF-8',
  async operation => {
    rows.set(operation, new Uint8Array([255]));
    const selected = await auth();
    const result =
      operation === 'diff'
        ? (await listBitbucketFiles(selected, identity, revision)).items[0]
        : await getBitbucketFileContext(selected, identity, context);
    expect(result).toMatchObject({
      content: 'unavailable',
      canonicalUrl: `https://bitbucket.org/fork/repo/src/${revision.headSha}/src/new.ts`,
    });
  }
);
it('AC4 ignores branching-model push rules when describing merge restrictions', async () => {
  rows.set('restrictions', [
    { kind: 'push', branch_match_kind: 'branching_model', pattern: '', users: [], groups: [] },
  ]);
  expect(
    (await getBitbucketReview(await auth(), '7')).authorization.capabilities.merge.restrictions
  ).toEqual([]);
});
it('AC4 refuses to return a next link that cannot fit the shared cursor', async () => {
  const prefix = `${apiRoot}/pullrequests?state=OPEN&pagelen=50&cursor=`;
  nextLinks.set('pullRequests', prefix + 'x'.repeat(4080 - prefix.length));
  await expect(listBitbucketInbox(await auth())).rejects.toMatchObject({
    code: 'invalid_pagination',
  });
});
it('AC4 retains documented summary text when the description field is absent', async () => {
  Object.assign(review, { description: undefined, summary: { raw: 'Documented review body' } });
  expect((await getBitbucketReview(await auth(), '7')).bodyMarkdown).toBe('Documented review body');
});
it('AC4 does not advertise branch deletion without a known default branch', async () => {
  rows.set('repository', { ...destination, mainbranch: null });
  review.source.repository = structuredClone(destination);
  rows.set('diffstat', []);
  const result = await getBitbucketReview(await auth(), '7');
  expect(result.authorization.capabilities.deleteBranch).toMatchObject({
    restrictions: ['default_branch_unknown'],
    explanation: 'default_branch_unknown',
    recovery: 'refresh',
  });
  expect(reviewActionAvailability(result.authorization.capabilities.deleteBranch)).toBe(
    'restricted'
  );
});
it('AC4 treats non-wildcard pattern characters literally', async () => {
  review.destination.branch.name = 'release/stable.v1';
  rows.set('branch', { name: review.destination.branch.name, merge_strategies: ['merge_commit'] });
  rows.set('restrictions', [
    { kind: 'restrict_merges', pattern: 'release/stable?v1', users: [], groups: [] },
    { kind: 'restrict_merges', pattern: 'release/stable[v1]', users: [], groups: [] },
  ]);
  expect(
    (await getBitbucketReview(await auth(), '7')).authorization.capabilities.merge.restrictions
  ).toEqual([]);
});

// Bitbucket returns an empty commit list after source branch deletion.
// https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/#api-repositories-workspace-repo-slug-pullrequests-pull-request-id-commits-get
it.each(['MERGED', 'DECLINED', 'SUPERSEDED'])(
  'c2-r3 AC4 reads an abbreviated %s review after source branch deletion',
  async state => {
    review.state = state;
    review.source.commit.hash = revision.headSha.slice(0, 12);
    Object.assign(review.source, { branch: null });
    rows.set('commits', []);
    const selected = await auth();
    const overview = await getBitbucketReview(selected, '7');
    expect(overview).toMatchObject({
      state: state === 'MERGED' ? 'merged' : 'closed',
      revision,
      source: { branch: null },
      counts: { commits: 0, files: 1 },
    });
    expect((await listBitbucketFiles(selected, identity, revision)).items[0]).toMatchObject({
      content: 'available',
      revision: fileRevision,
      patch,
    });
    expect(await getBitbucketFileContext(selected, identity, context)).toMatchObject({
      content: 'available',
      revision: fileRevision,
      lines: ['second', 'third'],
      canonicalUrl: `https://bitbucket.org/fork/repo/src/${revision.headSha}/src/new.ts`,
    });
    expect(await getBitbucketChecks(selected, identity, revision)).toEqual({
      status: 'none',
      checks: [],
    });
    expect(
      (await listBitbucketDiscussions(selected, identity)).items[0].comments.items
    ).toHaveLength(2);
  }
);
it.each([
  {},
  { hash: null },
  { hash: 123 },
  { hash: 'a'.repeat(12) },
  { hash: 'g'.repeat(40) },
  { hash: 'a'.repeat(41) },
  { hash: 'd'.repeat(40) },
])('c2-r3 AC4 rejects invalid resolved source commit %j', async data => {
  review.source.commit.hash = revision.headSha.slice(0, 12);
  rows.set('commits', []);
  rows.set(`commit:${review.source.commit.hash}`, data);
  await expect(getBitbucketChecks(await auth(), identity)).rejects.toMatchObject({
    code: 'invalid_response',
  });
});
it.each([
  ['commit', 401, 'authentication_rejected'],
  ['commit', 403, 'insufficient_permissions'],
  ['commit', 404, 'not_found'],
  ['commit', 429, 'rate_limited'],
  ['commit', 503, 'provider_unavailable'],
  ['commits', 403, 'insufficient_permissions'],
  ['commits', 503, 'provider_unavailable'],
] as const)(
  'c2-r3 AC4 preserves %s failure %s during source resolution',
  async (operation, status, code) => {
    review.source.commit.hash = revision.headSha.slice(0, 12);
    rows.set('commits', []);
    failures.set(operation, status);
    const error = await getBitbucketChecks(await auth(), identity).catch((error: unknown) => error);
    expect(error).toMatchObject({ code, message: code });
    expect(JSON.stringify(error)).not.toContain('provider-secret');
  }
);
it('c2-r3 AC5 rejects a resolved prefix collision before reading fork context', async () => {
  review.source.commit.hash = revision.headSha.slice(0, 12);
  rows.set('commits', []);
  rows.set(`commit:${review.source.commit.hash}`, { hash: 'a'.repeat(12) + 'd'.repeat(28) });
  await expect(getBitbucketFileContext(await auth(), identity, context)).rejects.toMatchObject({
    code: 'conflict',
  });
});
it.each(['revision', 'repository', 'workspace'] as const)(
  'c2-r3 AC5 rejects fork %s drift after abbreviated context resolution',
  async field => {
    review.source.commit.hash = revision.headSha.slice(0, 12);
    rows.set('commits', []);
    afterResponse = operation => {
      if (operation !== 'file') return;
      if (field === 'revision')
        rows.set(`commit:${review.source.commit.hash}`, { hash: 'a'.repeat(12) + 'd'.repeat(28) });
      if (field === 'repository')
        review.source.repository.uuid = '{99999999-9999-4999-8999-999999999999}';
      if (field === 'workspace')
        review.source.repository.workspace.uuid = '{99999999-9999-4999-8999-999999999999}';
    };
    await expect(getBitbucketFileContext(await auth(), identity, context)).rejects.toMatchObject({
      code: 'conflict',
    });
  }
);

// The diff endpoint returns raw git-style hunks, independently of diffstat counts.
// https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commits/#api-repositories-workspace-repo-slug-diff-spec-get
it.each([
  ['missing addition with null counts', '@@ -1 +1,2 @@\n-old\n+first\n', null, null],
  ['missing deletion with null counts', '@@ -1,2 +1 @@\n-old\n+first\n', null, null],
  ['missing context with matching counts', '@@ -1,2 +1,3 @@\n-old\n+first\n+second\n', 2, 1],
  ['empty hunk with zero counts', '@@ -1 +1 @@\n', 0, 0],
  ['excess body lines with matching counts', '@@ -1 +1 @@\n-old\n+first\n+extra\n', 2, 1],
  ['incomplete earlier hunk', '@@ -1 +1,2 @@\n-old\n+first\n@@ -5 +6 @@\n-later\n+last\n', 2, 2],
] as const)(
  'c2-r3 AC5 marks %s as truncated and retains the provider link',
  async (_name, value, lines_added, lines_removed) => {
    rows.set('diff', value);
    rows.set('diffstat', [{ ...stat, lines_added, lines_removed }]);
    expect((await listBitbucketFiles(await auth(), identity, revision)).items[0]).toMatchObject({
      content: 'truncated',
      patch: null,
      additions: lines_added,
      deletions: lines_removed,
      canonicalUrl: `https://bitbucket.org/fork/repo/src/${revision.headSha}/src/new.ts`,
    });
  }
);
it.each([
  ['complete hunk with null counts', patch, null, null],
  ['omitted hunk lengths', '@@ -1 +1 @@\n-old\n+first\n', 1, 1],
  ['zero old length', '@@ -0,0 +1,2 @@\n+first\n+second\n', 2, 0],
  ['zero new length', '@@ -1,2 +0,0 @@\n-old\n-removed\n', 0, 2],
  ['context lines', '@@ -1,2 +1,3 @@\n context\n-old\n+first\n+second\n', 2, 1],
  ['multiple hunks', '@@ -1 +1 @@\n-old\n+first\n@@ -5 +5,2 @@\n context\n+second\n', 2, 1],
  [
    'no newline markers',
    '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+first\n\\ No newline at end of file\n',
    1,
    1,
  ],
  [
    'rename without hunks',
    'diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n',
    0,
    0,
  ],
  ['confirmed empty patch', '', 0, 0],
] as const)(
  'c2-r3 AC5 retains an available patch for %s',
  async (_name, value, lines_added, lines_removed) => {
    rows.set('diff', value);
    rows.set('diffstat', [{ ...stat, lines_added, lines_removed }]);
    expect((await listBitbucketFiles(await auth(), identity, revision)).items[0]).toMatchObject({
      content: 'available',
      patch: value,
      additions: lines_added,
      deletions: lines_removed,
      canonicalUrl: `https://bitbucket.org/fork/repo/src/${revision.headSha}/src/new.ts`,
    });
  }
);

// Only push/restrict_merges rules have actor exceptions; delete rules protect all matching branches.
// https://developer.atlassian.com/cloud/bitbucket/rest/api-group-branch-restrictions/#api-repositories-workspace-repo-slug-branch-restrictions-post
it.each(['feature', 'feat*', '*'])(
  'c2-r3 AC6 restricts source deletion matching %s without changing destination merge policy',
  async pattern => {
    review.source.repository = structuredClone(destination);
    rows.set('diffstat', []);
    rows.set('restrictions', [
      { kind: 'delete', pattern },
      { kind: 'enforce_merge_checks', pattern: 'release/*' },
      { kind: 'require_approvals_to_merge', pattern: 'release/*', value: 2 },
    ]);
    const { capabilities } = (await getBitbucketReview(await auth(), '7')).authorization;
    expect(reviewActionAvailability(capabilities.deleteBranch)).toBe('restricted');
    expect(capabilities.deleteBranch).toMatchObject({
      permission: 'allowed',
      restrictions: ['source_branch_protected'],
      explanation: 'source_branch_protected',
      recovery: 'openProvider',
    });
    expect(capabilities.merge.restrictions).toEqual(['approvals_required']);
  }
);
it.each([
  [{ kind: 'push', pattern: 'feature', users: [], groups: [] }, 'actor_delete_restricted'],
  [
    { kind: 'push', pattern: 'feature', users: [], groups: [{ slug: 'developers' }] },
    'delete_group_membership_unknown',
  ],
  [
    { kind: 'delete', branch_match_kind: 'branching_model', pattern: '', branch_type: 'feature' },
    'branching_model_restrictions_unknown',
  ],
  [
    {
      kind: 'push',
      branch_match_kind: 'branching_model',
      pattern: '',
      branch_type: 'feature',
      users: [],
      groups: [],
    },
    'branching_model_restrictions_unknown',
  ],
] as const)('c2-r3 AC6 preserves source restriction evidence %j', async (rule, restriction) => {
  oauth();
  review.source.repository = structuredClone(destination);
  rows.set('diffstat', []);
  rows.set('restrictions', [rule]);
  const { capabilities } = (await getBitbucketReview(await auth(), '7')).authorization;
  expect(reviewActionAvailability(capabilities.deleteBranch)).toBe('restricted');
  expect(capabilities.deleteBranch).toMatchObject({
    restrictions: [restriction],
    explanation: restriction,
    recovery: 'openProvider',
  });
  expect(capabilities.merge).toMatchObject({
    permission: 'unknown',
    restrictions: [],
    explanation: 'repository_merge_permission_unknown',
  });
});
it.each([
  [403, 1],
  [404, 1],
  [403, 2],
])(
  'c2-r3 AC6 does not advertise deletion after restriction failure %s on page %s',
  async (status, page) => {
    review.source.repository = structuredClone(destination);
    rows.set('diffstat', []);
    if (page === 2) nextRows.set('restrictions', []);
    failures.set(`restrictions:${page}`, status);
    const result = await getBitbucketReview(await auth(), '7');
    expect(result.title).toBe('Fork review');
    const { capabilities } = result.authorization;
    expect(reviewActionAvailability(capabilities.deleteBranch)).toBe('restricted');
    expect(capabilities.deleteBranch).toMatchObject({
      restrictions: ['delete_restrictions_unavailable'],
      explanation: 'delete_restrictions_unavailable',
      recovery: 'openProvider',
    });
    expect(capabilities.merge.restrictions).toEqual(['merge_restrictions_unavailable']);
  }
);
it.each([
  ['workspace', [], 'available'],
  ['workspace', [{ kind: 'delete', pattern: 'release/*' }], 'available'],
  ['oauth', [{ kind: 'push', pattern: 'feature', users: [actor], groups: [] }], 'available'],
  ['workspace', [{ kind: 'push', pattern: 'feature', users: [actor], groups: [] }], 'restricted'],
] as const)(
  'c2-r3 AC6 retains %s actor permissions for source rules %j',
  async (kind, rules, availability) => {
    if (kind === 'oauth') oauth();
    review.source.repository = structuredClone(destination);
    rows.set('diffstat', []);
    rows.set('restrictions', rules);
    const { capabilities } = (await getBitbucketReview(await auth(), '7')).authorization;
    expect(reviewActionAvailability(capabilities.deleteBranch)).toBe(availability);
    expect(capabilities.merge.restrictions).toEqual([]);
  }
);
it.each([
  ['delete', [], 'restricted'],
  ['push', [], 'restricted'],
  ['push', [actor], 'available'],
] as const)(
  'c2-r3 AC6 handles a branching-model %s rule without a glob pattern and users %j',
  async (kind, users, availability) => {
    oauth();
    review.source.repository = structuredClone(destination);
    rows.set('diffstat', []);
    rows.set('restrictions', [
      { kind, branch_match_kind: 'branching_model', branch_type: 'feature', users, groups: [] },
    ]);
    const { capabilities } = (await getBitbucketReview(await auth(), '7')).authorization;
    expect(reviewActionAvailability(capabilities.deleteBranch)).toBe(availability);
    expect(capabilities.deleteBranch.restrictions).toEqual(
      availability === 'available' ? [] : ['branching_model_restrictions_unknown']
    );
    expect(capabilities.merge.restrictions).toEqual([]);
  }
);
it('c2-r3 AC6 rejects a glob deletion rule without its required pattern', async () => {
  review.source.repository = structuredClone(destination);
  rows.set('diffstat', []);
  rows.set('restrictions', [{ kind: 'delete', branch_match_kind: 'glob' }]);
  await expect(getBitbucketReview(await auth(), '7')).rejects.toMatchObject({
    code: 'invalid_response',
  });
});
it.each(['fork', 'default', 'destination', 'missing'] as const)(
  'c2-r3 AC6 preserves the %s source deletion guard with unprotected controls',
  async guard => {
    if (guard !== 'fork') review.source.repository = structuredClone(destination);
    if (guard === 'default') review.source.branch.name = 'trunk';
    if (guard === 'destination') review.source.branch.name = 'release/stable';
    if (guard === 'missing') Object.assign(review.source, { branch: null });
    rows.set('diffstat', []);
    const capability = (await getBitbucketReview(await auth(), '7')).authorization.capabilities
      .deleteBranch;
    expect(reviewActionAvailability(capability)).toBe('restricted');
    expect(capability.restrictions).toEqual([
      guard === 'fork'
        ? 'fork_source_requires_separate_authorization'
        : 'source_branch_not_deletable',
    ]);
  }
);
it.each(['workspace', 'oauth'])(
  'c2-r3 AC6 preserves missing %s write grants beside source protection',
  async kind => {
    if (kind === 'oauth') oauth();
    metadata.grants.scopes = ['repository', 'pullrequest', 'pullrequest:write'];
    review.source.repository = structuredClone(destination);
    rows.set('diffstat', []);
    rows.set('restrictions', [{ kind: 'delete', pattern: 'feature' }]);
    const capability = (await getBitbucketReview(await auth(), '7')).authorization.capabilities
      .deleteBranch;
    expect(reviewActionAvailability(capability)).toBe('forbidden');
    expect(capability).toMatchObject({
      restrictions: ['source_branch_protected'],
      explanation: 'missing_scope:repository:write',
      recovery: kind === 'oauth' ? 'reconnect' : 'replaceToken',
    });
  }
);
