jest.mock('@/lib/drizzle', () => ({ db: { select: jest.fn() } }));
jest.mock('@/lib/config.server', () => ({}));
jest.mock('./bitbucket-read', () => ({
  getBitbucketReview: jest.fn(),
  listBitbucketFiles: jest.fn(),
}));
jest.mock('./operation', () => ({
  ...jest.requireActual('./operation'),
  runReviewOperation: jest.fn(),
}));
jest.mock(
  '@/lib/integrations/platforms/bitbucket/workspace-access-token-organization-authorization',
  () => ({})
);

import { db } from '@/lib/drizzle';
import { repositoryResourceKey } from '@kilocode/app-shared/code-review/repository-identity';
import {
  providerReviewIntentFingerprint,
  type BitbucketMergeEvidence,
  type ReviewIntentInput,
  type ReviewOverview,
  type ReviewPosition,
} from '@kilocode/app-shared/provider-review';
import { reviewCapabilityFixtures } from '@kilocode/app-shared/provider-review/fixtures';
import { BitbucketInteractiveClientError } from '@/lib/integrations/platforms/bitbucket/interactive-client';
import { getBitbucketWorkspaceAccessTokenStatus } from '@/lib/integrations/platforms/bitbucket/workspace-access-token-repository-cache';
import { createBitbucketInteractiveApi } from '../../../../../services/git-token-service/src/bitbucket-interactive-api';
import {
  BitbucketApiError,
  BitbucketInteractiveError,
} from '../../../../../services/git-token-service/src/bitbucket-safe-transport';
import type { BitbucketReviewAuthorization } from './bitbucket-authorization';
import { getBitbucketReview, listBitbucketFiles } from './bitbucket-read';
import {
  rejectedReviewEffect,
  unresolvedReviewEffect,
  reviewEffectOperationKey,
  runReviewOperation,
  type ReviewEffectResult,
} from './operation';
import {
  runBitbucketReviewOperation,
  type BitbucketReviewOperationRequest as ReviewOperationRequest,
} from './bitbucket-write';

const userId = 'oauth/caller';
const authorization = {
  kind: 'ownerIntegration' as const,
  owner: { type: 'org' as const, id: '11111111-1111-4111-8111-111111111111' },
  integrationId: '22222222-2222-4222-8222-222222222222',
};
const repository = {
  provider: 'bitbucket' as const,
  instanceUrl: 'https://bitbucket.org',
  workspaceUuid: '33333333-3333-4333-8333-333333333333',
  repositoryId: '44444444-4444-4444-8444-444444444444',
  fullName: 'team/repo',
  defaultBranch: 'trunk',
};
const actorId = '55555555-5555-4555-8555-555555555555';
const identity = {
  repository,
  authorization,
  number: '7',
  reviewId: '7',
  canonicalUrl: 'https://bitbucket.org/team/repo/pull-requests/7',
};
const revision = {
  headSha: 'a'.repeat(40),
  targetHeadSha: 'b'.repeat(40),
  baseSha: null,
  startSha: null,
};
const position: ReviewPosition = {
  revision,
  oldPath: 'old.ts',
  newPath: 'new.ts',
  side: 'new',
  line: 4,
  startSide: 'new',
  startLine: 2,
  native: { provider: 'bitbucket', to: 4, startTo: 2 },
};
const nativeRepo = {
  uuid: `{${repository.repositoryId}}`,
  full_name: repository.fullName,
  workspace: { uuid: `{${repository.workspaceUuid}}` },
};
const root = `/2.0/repositories/{${repository.workspaceUuid}}/{${repository.repositoryId}}/pullrequests/7`;
const taskUrl = `https://api.bitbucket.org${root.replaceAll('{', '%7B').replaceAll('}', '%7D')}/merge/task-status/task-1`;
const target = {
  provider: 'bitbucket' as const,
  kind: 'thread' as const,
  id: '1',
  url: `${identity.canonicalUrl}/_/diff#comment-1`,
};
let auth: BitbucketReviewAuthorization;
let overview: ReviewOverview;
let pr: any;
let comments: any[];
let state: 'approved' | 'changes_requested' | null;
let merges: any[];
let events: string[];
let afterWrite: (() => void) | undefined;
let lostResponse: boolean;
let pendingMerge: boolean;
let taskState: 'PENDING' | 'SUCCESS' | 'error' | 'missing';
let taskSelf: string;
let taskLocation: string;
let responseOverride: ((value: any) => any) | undefined;
let readFailure: boolean;
let branchExists: boolean;
let sourceCommits: string[];
let sourceInDestination: boolean;
type StoredEffect = {
  fingerprint: string;
  result: ReviewEffectResult;
  active: boolean;
  mergeEvidence?: BitbucketMergeEvidence;
};
let records: Map<string, StoredEffect>;
const request = (input: ReviewIntentInput): ReviewOperationRequest => ({
  userId,
  distinctId: 'caller',
  operationKey: '66666666-6666-4666-8666-666666666666',
  intent: { accountId: userId, actorId: auth.actor.id, review: identity, revision, input },
});
const run = (input: ReviewIntentInput, statusOnly = false) =>
  runBitbucketReviewOperation(auth, request(input), statusOnly);
function finishMerge() {
  pr.state = 'MERGED';
  pr.merge_commit = { hash: 'c'.repeat(40) };
}

beforeEach(() => {
  jest.resetAllMocks();
  records = new Map();
  comments = [
    {
      type: 'pullrequest_comment',
      id: 1,
      content: { raw: 'Original' },
      pullrequest: { id: 7 },
      user: { uuid: actorId },
    },
  ];
  pr = {
    type: 'pullrequest',
    id: 7,
    state: 'OPEN',
    links: { html: { href: identity.canonicalUrl } },
    source: {
      repository: nativeRepo,
      branch: { name: 'feature' },
      commit: { hash: revision.headSha },
    },
    destination: {
      repository: nativeRepo,
      branch: { name: 'trunk' },
      commit: { hash: revision.targetHeadSha },
    },
  };
  state = null;
  merges = [];
  events = [];
  afterWrite = undefined;
  lostResponse = false;
  pendingMerge = false;
  taskState = 'PENDING';
  taskSelf = taskUrl;
  taskLocation = taskUrl;
  responseOverride = undefined;
  readFailure = false;
  branchExists = true;
  sourceCommits = [revision.headSha];
  sourceInDestination = true;
  const api = createBitbucketInteractiveApi({
    scope: {
      kind: 'repository',
      workspace: `{${repository.workspaceUuid}}`,
      repository: `{${repository.repositoryId}}`,
    },
    accessToken: 'provider-fixture',
    // Mirror the broker's verified repository aliases; request paths remain UUID-based.
    canonicalTaskRepository: {
      workspace: repository.fullName.split('/')[0],
      repository: repository.fullName.split('/')[1],
    },
    fetch: async (url, init) => {
      const route = decodeURIComponent(new URL(String(url)).pathname);
      const method = init?.method;
      if (new Headers(init?.headers).has('if-match')) throw new Error('Undocumented guard');
      if (method === 'GET') {
        if (route === `${root}/commits`)
          return Response.json({ values: sourceCommits.map(hash => ({ hash })) });
        if (
          !sourceInDestination &&
          route.includes('/commit/') &&
          revision.headSha.startsWith(route.split('/').at(-1)!)
        )
          return Response.json({}, { status: 404 });
        if (route === root)
          return Response.json(pr, { status: readFailure && events.length ? 503 : 200 });
        if (route === `${root}/merge/task-status/task-1`) {
          if (taskState === 'error')
            return Response.json({ type: 'error', error: { message: 'Merge failed' } });
          if (taskState === 'SUCCESS') finishMerge();
          return Response.json({
            task_status: taskState === 'missing' ? 'SUCCESS' : taskState,
            links: { self: { href: taskSelf } },
            ...(taskState === 'SUCCESS'
              ? { merge_result: responseOverride ? responseOverride(pr) : pr }
              : {}),
          });
        }
        if (route.startsWith(`${root}/comments/`)) {
          const value = comments.find(comment => String(comment.id) === route.split('/').at(-1));
          return Response.json(value ?? {}, { status: value ? 200 : 404 });
        }
        if (route.endsWith('/refs/branches/feature'))
          return Response.json(
            { name: 'feature', target: { hash: revision.headSha } },
            { status: branchExists ? 200 : 404 }
          );
        if (route.includes('/commit/')) {
          const short = route.split('/').at(-1)!;
          const hash = [revision.headSha, revision.targetHeadSha, 'c'.repeat(40)].find(value =>
            value.startsWith(short)
          );
          return Response.json({ hash }, { status: hash ? 200 : 404 });
        }
        return Response.json({}, { status: 404 });
      }
      let value: unknown = null,
        status = method === 'DELETE' ? 204 : 200;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (route === `${root}/comments` && method === 'POST') {
        value = {
          ...body,
          id: comments.length + 1,
          pullrequest: { id: 7 },
          user: { uuid: actorId },
        };
        comments.push(value);
        status = 201;
        events.push('comment');
      } else if (route === `${root}/comments/1/resolve`) {
        comments[0].resolution = method === 'POST' ? { type: 'comment_resolution' } : null;
        value = comments[0].resolution;
        events.push(method === 'POST' ? 'resolve' : 'reopen');
      } else if (route === `${root}/approve` || route === `${root}/request-changes`) {
        state =
          method === 'DELETE'
            ? null
            : route.endsWith('/approve')
              ? 'approved'
              : 'changes_requested';
        value =
          method === 'DELETE' ? null : { type: 'participant', user: { uuid: actorId }, state };
        events.push(`${method}:${route.split('/').at(-1)}`);
      } else if (route === `${root}/merge` && method === 'POST') {
        merges.push(body);
        events.push('merge');
        if (!pendingMerge) finishMerge();
        value = pr;
      } else return Response.json({}, { status: 400 });
      afterWrite?.();
      if (lostResponse) throw new Error('Provider committed; response lost');
      if (pendingMerge && route.endsWith('/merge'))
        return new Response(null, { status: 202, headers: { location: taskLocation } });
      return status === 204
        ? new Response(null, { status })
        : Response.json(responseOverride ? responseOverride(value) : value, { status });
    },
  });
  auth = {
    userId,
    authorization,
    repository,
    path: { workspace: `{${repository.workspaceUuid}}`, repo_slug: `{${repository.repositoryId}}` },
    actor: {
      provider: 'bitbucket',
      instanceUrl: repository.instanceUrl,
      id: actorId,
      login: 'service-actor',
      displayName: null,
      avatarUrl: null,
    },
    credentialKind: 'bitbucketOAuth',
    scopes: [
      'account',
      'repository',
      'repository:write',
      'pullrequest',
      'pullrequest:write',
      'webhook',
    ],
    client: {
      execute: async input => {
        try {
          return { ...(await api.execute(input)), metadata: {} } as any;
        } catch (error) {
          if (error instanceof BitbucketApiError || error instanceof BitbucketInteractiveError)
            throw new BitbucketInteractiveClientError(error.code);
          throw error;
        }
      },
    },
  };
  overview = {
    identity,
    title: 'Review',
    bodyMarkdown: null,
    author: null,
    state: 'open',
    draft: false,
    revision,
    source: { repository, branch: 'feature' },
    target: { repository, branch: 'trunk' },
    authorization: {
      actor: auth.actor,
      credentialKind: auth.credentialKind,
      capabilities: reviewCapabilityFixtures('bitbucket'),
      writeLimits: { requestMaxBytes: 256_000, bodyMaxBytes: null },
    },
    providerState: { provider: 'bitbucket', expectedHeadProtection: 'none', participants: [] },
    checks: { status: 'none', checks: [] },
    counts: { files: 1, commits: 1, additions: 1, deletions: 0 },
    merge: {
      methods: [
        'merge_commit',
        'squash',
        'fast_forward',
        'squash_fast_forward',
        'rebase_fast_forward',
        'rebase_merge',
      ].map(id => ({ id, label: id })),
      squash: null,
      autoMerge: null,
      task: null,
    },
  };
  jest.mocked(getBitbucketReview).mockImplementation(async () => structuredClone(overview));
  jest.mocked(listBitbucketFiles).mockResolvedValue({
    items: [
      {
        id: 'file',
        oldPath: 'old.ts',
        newPath: 'new.ts',
        revision,
        status: 'renamed',
        patch: null,
        content: 'available',
        additions: 1,
        deletions: 0,
        canonicalUrl: null,
      },
    ],
    nextCursor: null,
  });
  // The c3 suite tests PostgreSQL admission. This stateful boundary makes a missing ledger call
  // observable here as a duplicate provider effect, including after status-only recovery.
  jest.mocked(runReviewOperation).mockImplementation(async (input, handlers) => {
    const key = reviewEffectOperationKey(input.operationKey, input.effect?.id);
    const fingerprint = providerReviewIntentFingerprint(input.intent);
    const existing = records.get(key);
    if (existing?.fingerprint && existing.fingerprint !== fingerprint)
      return rejectedReviewEffect('operation_key_reuse_mismatch');
    if (existing?.active) return unresolvedReviewEffect('operation_in_progress');
    if (
      existing &&
      (existing.result.status === 'confirmed' ||
        (existing.result.status === 'rejected' && existing.result.retry === 'never'))
    )
      return existing.result;
    if (!existing && !handlers.execute)
      return rejectedReviewEffect('operation_not_admitted', 'same-key');
    const row: StoredEffect = existing ?? {
      fingerprint,
      result: unresolvedReviewEffect('dispatching'),
      active: false,
    };
    records.set(key, row);
    row.active = true;
    const stored = existing?.result ?? null;
    const result = await (handlers.execute &&
    (!existing || (stored?.status === 'rejected' && stored.retry === 'same-key'))
      ? handlers.execute(async evidence => {
          row.mergeEvidence = structuredClone(evidence);
        })
      : handlers.reconcile(stored, row.mergeEvidence));
    row.active = false;
    if (!(result.status === 'unresolved' && stored?.status === 'accepted')) row.result = result;
    return result;
  });
});

it.each([
  { action: 'comment', body: 'Summary' },
  { action: 'inlineComment', body: 'Inline', position },
  { action: 'reply', body: 'Reply', target },
] satisfies ReviewIntentInput[])(
  'AC6 posts $action to the PR and never claims atomic revision success',
  async input => {
    const result = await run(input);
    expect(result).toMatchObject({
      status: 'unresolved',
      reason: 'no_atomic_revision_guard',
      reference: { kind: 'comment', id: '2' },
      retry: 'reconcile',
    });
    expect(comments[1]).toMatchObject({
      content: { raw: input.body },
      pullrequest: { id: 7 },
      user: { uuid: actorId },
    });
    if (input.action === 'inlineComment')
      expect(comments[1].inline).toEqual({ path: 'new.ts', to: 4, start_to: 2 });
    if (input.action === 'reply') expect(comments[1].parent.id).toBe(1);
    expect(await run(input, true)).toEqual(result);
    await run(input);
    expect(comments).toHaveLength(2);
  }
);

it('AC6 preserves old-side path and range rather than translating them to the new side', async () => {
  const old: ReviewPosition = {
    ...position,
    side: 'old',
    startSide: 'old',
    native: { provider: 'bitbucket', from: 4, startFrom: 2 },
  };
  await run({ action: 'inlineComment', body: 'Old range', position: old });
  expect(comments[1].inline).toEqual({ path: 'old.ts', from: 4, start_from: 2 });
});

it.each(['approve', 'unapprove', 'requestChanges', 'removeChangeRequest'] as const)(
  'AC6 applies %s under the authorized actor',
  async action => {
    state =
      action === 'unapprove'
        ? 'approved'
        : action === 'removeChangeRequest'
          ? 'changes_requested'
          : null;
    expect(await run({ action })).toMatchObject({
      status: 'unresolved',
      reason: 'no_atomic_revision_guard',
    });
    expect(state).toBe(
      action === 'approve' ? 'approved' : action === 'requestChanges' ? 'changes_requested' : null
    );
    await run({ action });
    expect(events).toHaveLength(1);
  }
);

it.each(['resolveThread', 'reopenThread'] as const)(
  'AC6 applies %s to the exact PR comment',
  async action => {
    comments[0].resolution = action === 'reopenThread' ? {} : null;
    expect(await run({ action, target })).toMatchObject({
      status: 'unresolved',
      reason: 'no_atomic_revision_guard',
    });
    expect(comments[0].resolution != null).toBe(action === 'resolveThread');
    await run({ action, target });
    expect(events).toHaveLength(1);
  }
);

it.each(['headSha', 'targetHeadSha'] as const)(
  'AC6 rejects stale %s before a provider write',
  async field => {
    overview.revision = { ...revision, [field]: 'd'.repeat(40) };
    expect(await run({ action: 'comment', body: 'Draft' })).toMatchObject({
      status: 'rejected',
      code: 'conflict',
      retry: 'never',
    });
    expect(comments).toHaveLength(1);
  }
);

it.each(['head', 'target', 'branch', 'resource', 'read failure'] as const)(
  'AC6 retains uncertainty after postflight %s drift',
  async change => {
    afterWrite = () => {
      if (change === 'head') pr.source.commit.hash = 'd'.repeat(40);
      if (change === 'target') pr.destination.commit.hash = 'd'.repeat(40);
      if (change === 'branch') pr.source.branch.name = 'different';
      if (change === 'resource') pr.id = 8;
      if (change === 'read failure') readFailure = true;
    };
    expect(await run({ action: 'comment', body: 'Draft' })).toMatchObject({
      status: 'unresolved',
      reason: 'provider_outcome_unknown',
      reference: { id: '2' },
    });
    await run({ action: 'comment', body: 'Draft' });
    expect(comments).toHaveLength(2);
  }
);

it.each(['id', 'body', 'position', 'actor'] as const)(
  'AC6 rejects incorrect returned %s evidence',
  async field => {
    responseOverride = value => ({
      ...value,
      ...(field === 'id'
        ? { pullrequest: { id: 8 } }
        : field === 'body'
          ? { content: { raw: 'Other' } }
          : field === 'position'
            ? { inline: { path: 'other.ts', to: 4, start_to: 2 } }
            : { user: { uuid: '77777777-7777-4777-8777-777777777777' } }),
    });
    expect(await run({ action: 'inlineComment', body: 'Draft', position })).toMatchObject({
      status: 'unresolved',
      reason: 'provider_outcome_unknown',
      reference: null,
    });
    expect(comments).toHaveLength(2);
  }
);

it.each(['comment', 'reply', 'approve', 'resolveThread'] as const)(
  'AC6 never repeats %s after a lost response',
  async action => {
    const input: ReviewIntentInput =
      action === 'comment'
        ? { action, body: 'Draft' }
        : action === 'reply'
          ? { action, body: 'Reply', target }
          : action === 'resolveThread'
            ? { action, target }
            : { action };
    lostResponse = true;
    expect(await run(input)).toMatchObject({ status: 'unresolved', retry: 'reconcile' });
    lostResponse = false;
    await run(input, true);
    await run(input);
    expect(events).toHaveLength(1);
  }
);

it('AC6 keeps each batch receipt and does not duplicate summary, inline, or decision effects', async () => {
  const input: ReviewIntentInput = {
    action: 'submitReview',
    body: 'Summary',
    choice: 'approve',
    comments: [{ itemId: 'one', body: 'Inline', position }],
  };
  const result = await run(input);
  expect(result).toMatchObject({
    status: 'partial',
    items: [
      { itemId: 'comment:one', result: { status: 'unresolved', reference: { id: '2' } } },
      { itemId: 'summary', result: { status: 'unresolved', reference: { id: '3' } } },
      { itemId: 'decision', result: { status: 'unresolved' } },
    ],
  });
  expect(comments.map(value => value.content.raw)).toEqual(['Original', 'Inline', 'Summary']);
  expect(state).toBe('approved');
  await run(input, true);
  await run(input);
  expect(comments).toHaveLength(3);
  expect(events).toHaveLength(3);
  expect(records.size).toBe(4);
});

it('AC6 stops an uncertain batch without discarding unfinished items', async () => {
  lostResponse = true;
  expect(
    await run({
      action: 'submitReview',
      body: 'Summary',
      comments: [{ itemId: 'one', body: 'Inline', position }],
    })
  ).toMatchObject({
    status: 'partial',
    items: [
      { itemId: 'comment:one', result: { status: 'unresolved' } },
      { itemId: 'summary', result: { status: 'rejected', retry: 'same-key' } },
    ],
  });
  expect(comments.map(value => value.content.raw)).toEqual(['Original', 'Inline']);
});

it('AC6 admits an empty review without fabricating a provider effect', async () => {
  expect(await run({ action: 'submitReview', choice: 'comment', comments: [] })).toMatchObject({
    status: 'confirmed',
    reference: null,
  });
  expect(events).toEqual([]);
  expect(comments).toHaveLength(1);
});

it.each([
  'merge_commit',
  'squash',
  'fast_forward',
  'squash_fast_forward',
  'rebase_fast_forward',
  'rebase_merge',
])('AC7 uses the supported %s destination strategy', async method => {
  expect(await run({ action: 'merge', method })).toMatchObject({
    status: 'confirmed',
    reference: { kind: 'review', id: '7' },
  });
  expect(pr.state).toBe('MERGED');
  expect(merges).toEqual([
    { type: 'pullrequest_merge_parameters', merge_strategy: method, close_source_branch: false },
  ]);
  await run({ action: 'merge', method });
  expect(merges).toHaveLength(1);
});

it.each(['empty methods', 'restriction', 'permission'] as const)(
  'AC7 blocks merge for %s',
  async condition => {
    if (condition === 'empty methods') overview.merge.methods = [];
    if (condition === 'restriction')
      overview.authorization.capabilities.merge.restrictions = ['changes_requested'];
    if (condition === 'permission')
      overview.authorization.capabilities.merge.permission = 'forbidden';
    expect(await run({ action: 'merge', method: 'merge_commit' })).toMatchObject({
      status: 'rejected',
      retry: 'never',
    });
    expect(merges).toEqual([]);
    expect(pr.state).toBe('OPEN');
  }
);

it('AC7 persists and polls the same accepted task before confirming its merge', async () => {
  pendingMerge = true;
  const input: ReviewIntentInput = { action: 'merge', method: 'merge_commit' };
  expect(await run(input)).toMatchObject({
    status: 'accepted',
    reference: { id: 'task-1', url: taskUrl },
    task: { state: 'pending' },
  });
  expect([...records.values()][0].result).toMatchObject({
    status: 'accepted',
    reference: { id: 'task-1' },
  });
  expect(await run(input, true)).toMatchObject({ status: 'accepted' });
  taskState = 'SUCCESS';
  expect(await run(input, true)).toMatchObject({ status: 'confirmed' });
  expect(pr.state).toBe('MERGED');
  expect(merges).toHaveLength(1);
});

it.each(['error', 'missing', 'wrong task', 'wrong review', 'drift'] as const)(
  'AC7 keeps %s task evidence unresolved without resubmitting',
  async condition => {
    pendingMerge = true;
    const input: ReviewIntentInput = { action: 'merge', method: 'merge_commit' };
    await run(input);
    taskState = condition === 'error' || condition === 'missing' ? condition : 'SUCCESS';
    if (condition === 'wrong task') taskSelf = taskUrl.replace('task-1', 'task-2');
    if (condition === 'wrong review') responseOverride = value => ({ ...value, id: 8 });
    if (condition === 'drift') pr.source.commit.hash = 'd'.repeat(40);
    expect(await run(input, true)).toMatchObject({ status: 'unresolved', retry: 'reconcile' });
    expect([...records.values()][0].result).toMatchObject({
      status: 'accepted',
      reference: { id: 'task-1' },
    });
    await run(input);
    expect(merges).toHaveLength(1);
  }
);

it('AC7 reconciles a lost merge response without another merge', async () => {
  lostResponse = true;
  const input: ReviewIntentInput = { action: 'merge', method: 'merge_commit' };
  expect(await run(input)).toMatchObject({ status: 'unresolved' });
  lostResponse = false;
  expect(await run(input, true)).toMatchObject({ status: 'confirmed' });
  expect(merges).toHaveLength(1);
});

it.each([true, false])(
  'AC7 reports branch deletion separately when the branch remains: %s',
  async exists => {
    afterWrite = () => {
      branchExists = exists;
    };
    const input: ReviewIntentInput = {
      action: 'merge',
      method: 'merge_commit',
      deletion: {
        effect: 'delete',
        branch: 'feature',
        expectedHeadSha: revision.headSha,
        repositoryKey: repositoryResourceKey(userId, { repository, authorization }),
      },
    };
    const result = await run(input);
    expect(result).toMatchObject(
      exists
        ? {
            status: 'partial',
            items: [
              { effect: 'merge', result: { status: 'confirmed' } },
              {
                effect: 'deleteBranch',
                result: { status: 'unresolved', reason: 'source_branch_still_present' },
              },
            ],
          }
        : { status: 'confirmed' }
    );
    expect(merges[0].close_source_branch).toBe(true);
    await run(input, true);
    expect(events).toEqual(['merge']);
    expect(records.size).toBe(3);
  }
);

it('AC7 does not infer deletion from a masked access failure', async () => {
  afterWrite = () => {
    branchExists = false;
  };
  const execute = auth.client.execute;
  auth.client.execute = async input => {
    try {
      return await execute(input);
    } catch (error) {
      if (input.operation === 'branch') readFailure = true;
      throw error;
    }
  };
  expect(
    await run({
      action: 'merge',
      method: 'merge_commit',
      deletion: {
        effect: 'delete',
        branch: 'feature',
        expectedHeadSha: revision.headSha,
        repositoryKey: repositoryResourceKey(userId, { repository, authorization }),
      },
    })
  ).toMatchObject({
    status: 'partial',
    items: [
      { effect: 'merge', result: { status: 'confirmed' } },
      {
        effect: 'deleteBranch',
        result: { status: 'unresolved', reason: 'source_branch_deletion_unknown' },
      },
    ],
  });
  expect(events).toEqual(['merge']);
});

it('AC1 keeps read-only grants usable and requires a new admitted action after reconnect', async () => {
  overview.authorization.capabilities.approve.permission = 'forbidden';
  expect(await run({ action: 'approve' })).toMatchObject({
    status: 'rejected',
    code: 'insufficient_permissions',
  });
  expect(events).toEqual([]);
  overview.authorization.capabilities.approve.permission = 'allowed';
  const replacement = request({ action: 'approve' });
  replacement.operationKey = '88888888-8888-4888-8888-888888888888';
  expect(await runBitbucketReviewOperation(auth, replacement)).toMatchObject({
    status: 'unresolved',
    reason: 'no_atomic_revision_guard',
  });
  expect(state).toBe('approved');
});

it('AC6 distinguishes retryable preflight failure from an uncertain write', async () => {
  jest
    .mocked(getBitbucketReview)
    .mockRejectedValueOnce(new BitbucketInteractiveClientError('temporarily_unavailable'));
  expect(await run({ action: 'comment', body: 'Draft' })).toMatchObject({
    status: 'rejected',
    retry: 'same-key',
  });
  expect(comments).toHaveLength(1);
  expect(await run({ action: 'comment', body: 'Draft' })).toMatchObject({
    status: 'unresolved',
    retry: 'reconcile',
  });
  expect(comments).toHaveLength(2);
});

it('AC6 rejects missing revisions, wrong actors, malformed positions, and wrong target resources', async () => {
  const missing = request({ action: 'approve' });
  delete (missing.intent as any).revision;
  await expect(runBitbucketReviewOperation(auth, missing)).rejects.toMatchObject({
    code: 'invalid_request',
  });
  const other = request({ action: 'approve' });
  other.intent.actorId = 'other';
  expect(await runBitbucketReviewOperation(auth, other)).toMatchObject({
    status: 'rejected',
    code: 'operation_identity_mismatch',
  });
  await expect(
    run({ action: 'inlineComment', body: 'Draft', position: { ...position, line: 5 } })
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(
    run({
      action: 'reply',
      body: 'Reply',
      target: { ...target, url: target.url.replace('/7/', '/8/') },
    })
  ).rejects.toMatchObject({ code: 'invalid_request' });
  expect(events).toEqual([]);
});

it('AC6 binds a file base independently from the overview revision', async () => {
  const fileRevision = { ...revision, baseSha: 'd'.repeat(40) };
  jest.mocked(listBitbucketFiles).mockResolvedValueOnce({
    items: [{ oldPath: 'old.ts', newPath: 'new.ts', revision: fileRevision } as any],
    nextCursor: null,
  });
  expect(
    await run({
      action: 'inlineComment',
      body: 'File base',
      position: { ...position, revision: fileRevision },
    })
  ).toMatchObject({ status: 'unresolved', reference: { id: '2' } });
  expect(comments[1].inline).toEqual({ path: 'new.ts', to: 4, start_to: 2 });
});

it('AC6 never upgrades an unverified participant receipt during status recovery', async () => {
  lostResponse = true;
  await run({ action: 'approve' });
  lostResponse = false;
  expect(await run({ action: 'approve' }, true)).toMatchObject({
    status: 'unresolved',
    reason: 'provider_outcome_unknown',
  });
  expect(events).toEqual(['POST:approve']);
});

it('AC6 keeps a post-write credential fence unresolved rather than reporting rejection', async () => {
  const execute = auth.client.execute;
  auth.client.execute = async input => {
    const result = await execute(input);
    if (input.operation === 'approve')
      throw new BitbucketInteractiveClientError('reconnect_required');
    return result;
  };
  expect(await run({ action: 'approve' })).toMatchObject({
    status: 'unresolved',
    retry: 'reconcile',
  });
  expect(state).toBe('approved');
  await run({ action: 'approve' }, true);
  await run({ action: 'approve' });
  expect(events).toEqual(['POST:approve']);
});

it.each(['approve', 'unapprove', 'requestChanges', 'removeChangeRequest', 'merge'] as const)(
  'AC6/AC7 rejects %s when the final preflight finds a closed PR',
  async action => {
    pr.state = 'DECLINED';
    expect(
      await run(action === 'merge' ? { action, method: 'merge_commit' } : { action })
    ).toMatchObject({ status: 'rejected', code: 'conflict' });
    expect(events).toEqual([]);
  }
);

it('AC6 admits concurrent taps once before the provider responds', async () => {
  const gate = Promise.withResolvers<void>();
  jest.mocked(getBitbucketReview).mockImplementationOnce(async () => {
    await gate.promise;
    return overview;
  });
  const first = run({ action: 'comment', body: 'Once' });
  await Promise.resolve();
  expect(await run({ action: 'comment', body: 'Once' })).toMatchObject({
    status: 'unresolved',
    reason: 'operation_in_progress',
  });
  gate.resolve();
  await first;
  expect(comments.map(value => value.content.raw)).toEqual(['Original', 'Once']);
});

it.each(['missing merge commit', 'changed head', 'changed destination'] as const)(
  'AC7 leaves %s evidence unresolved even after a successful response',
  async defect => {
    afterWrite = () => {
      if (defect === 'missing merge commit') delete pr.merge_commit;
      if (defect === 'changed head') pr.source.commit.hash = 'd'.repeat(40);
      if (defect === 'changed destination') pr.destination.commit.hash = 'd'.repeat(40);
    };
    expect(await run({ action: 'merge', method: 'merge_commit' })).toMatchObject({
      status: 'unresolved',
      retry: 'reconcile',
    });
    await run({ action: 'merge', method: 'merge_commit' });
    expect(merges).toHaveLength(1);
  }
);

it.each(['branch', 'repository', 'head', 'protected source', 'fork'] as const)(
  'AC7 rejects an unsafe deletion %s before merging',
  async defect => {
    const deletion = {
      effect: 'delete' as const,
      branch: 'feature',
      expectedHeadSha: revision.headSha,
      repositoryKey: repositoryResourceKey(userId, { repository, authorization }),
    };
    if (defect === 'branch') deletion.branch = 'trunk';
    if (defect === 'repository') deletion.repositoryKey = 'other-repository';
    if (defect === 'head') deletion.expectedHeadSha = 'd'.repeat(40);
    if (defect === 'protected source')
      overview.authorization.capabilities.deleteBranch.restrictions = ['source_branch_protected'];
    if (defect === 'fork')
      overview.source.repository = {
        ...repository,
        repositoryId: '77777777-7777-4777-8777-777777777777',
      };
    expect(await run({ action: 'merge', method: 'merge_commit', deletion })).toMatchObject({
      status: 'partial',
      items: [
        { effect: 'merge', result: { status: 'rejected', code: 'conflict' } },
        { effect: 'deleteBranch', result: { status: 'unresolved' } },
      ],
    });
    expect(merges).toEqual([]);
    expect(events).toEqual([]);
  }
);

it.each([
  ['legacy read', ['account', 'repository:write', 'pullrequest', 'webhook']],
  ['write implies read', ['account', 'pullrequest:write', 'webhook']],
] as const)(
  'AC1/AC6 permits comments with %s grants through the real c2 preflight',
  async (_label, scopes) => {
    auth.scopes = [...scopes];
    auth.credentialKind = 'bitbucketWorkspaceToken';
    auth.actor = { ...auth.actor, id: `workspace:${repository.workspaceUuid}` };
    Object.assign(pr, { title: 'Review', updated_on: '2026-08-30T00:00:00Z', participants: [] });
    const providerRepository = {
      ...nativeRepo,
      workspace: { ...nativeRepo.workspace, slug: 'team' },
    };
    pr.source.repository = providerRepository;
    pr.destination.repository = providerRepository;
    const execute = auth.client.execute;
    auth.client.execute = async input => {
      switch (input.operation) {
        case 'diffstat':
        case 'statuses':
        case 'restrictions':
          return { status: 200, data: { values: [] }, metadata: {} } as any;
        case 'commits':
          return {
            status: 200,
            data: { values: [{ hash: revision.headSha }] },
            metadata: {},
          } as any;
        case 'branch':
          return {
            status: 200,
            data: { name: 'trunk', merge_strategies: ['merge_commit'] },
            metadata: {},
          } as any;
        default:
          return execute(input);
      }
    };
    const actual = jest.requireActual<{ getBitbucketReview: typeof getBitbucketReview }>(
      './bitbucket-read'
    );
    jest.mocked(getBitbucketReview).mockImplementation(actual.getBitbucketReview);
    expect(await run({ action: 'comment', body: 'Readable grant' })).toMatchObject({
      status: 'unresolved',
      reason: 'no_atomic_revision_guard',
      reference: { id: '2' },
    });
    expect(comments.map(value => value.content.raw)).toEqual(['Original', 'Readable grant']);
  }
);

it('AC1 keeps cached repositories readable through replacement, invalidation, and reconnect', async () => {
  const timestamp = '2026-08-30 01:00:00.000+00';
  const credential = {
    id: 'credential',
    platform_integration_id: authorization.integrationId,
    token_encrypted: 'ciphertext',
    expires_at: null,
    provider_credential_type: 'workspace_access_token',
    provider_resource_id: null,
    provider_base_url: null,
    authorized_by_user_id: null,
    provider_metadata: null,
    provider_scopes: ['account', 'repository:write', 'pullrequest', 'webhook'],
    provider_verified_at: timestamp,
    credential_version: 1,
    last_validated_at: timestamp,
    last_used_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const row = {
    integrationId: authorization.integrationId,
    integrationStatus: 'active',
    installationId: null,
    workspaceUuid: repository.workspaceUuid,
    workspaceSlug: 'team',
    metadata: { displayName: 'Team' },
    repositories: [
      {
        id: repository.repositoryId,
        name: 'repo',
        full_name: repository.fullName,
        private: true,
        default_branch: 'trunk',
      },
    ],
    repositoriesSyncedAt: timestamp,
    authInvalidAt: null,
    authInvalidReason: null,
    credential,
  };
  jest.mocked(db.select).mockImplementation(
    () =>
      ({
        from: () => ({ leftJoin: () => ({ where: () => ({ limit: async () => [row] }) }) }),
      }) as any
  );
  const before = await getBitbucketWorkspaceAccessTokenStatus(authorization.owner.id);
  expect(before).toMatchObject({
    status: 'connected',
    recoveryAction: null,
    reviewPermissions: { readReady: true, writeReady: false, recoveryAction: 'replace_token' },
    repositoryCache: { status: 'available', repositories: [{ fullName: 'team/repo' }] },
  });
  credential.provider_scopes.push('pullrequest:write');
  credential.credential_version++;
  const after = await getBitbucketWorkspaceAccessTokenStatus(authorization.owner.id);
  expect(after).toMatchObject({
    status: 'connected',
    reviewPermissions: { readReady: true, writeReady: true, recoveryAction: null },
  });
  expect(after.repositoryCache).toEqual(before.repositoryCache);

  Object.assign(row, { authInvalidAt: timestamp, authInvalidReason: 'provider_rejected' });
  const invalidated = await getBitbucketWorkspaceAccessTokenStatus(authorization.owner.id);
  expect(invalidated).toMatchObject({
    status: 'reconnect_required',
    recoveryAction: 'replace_token',
    reviewPermissions: null,
  });
  expect(invalidated.repositoryCache).toEqual(before.repositoryCache);

  row.integrationId = '99999999-9999-4999-8999-999999999999';
  Object.assign(row, { authInvalidAt: null, authInvalidReason: null });
  credential.platform_integration_id = row.integrationId;
  credential.provider_scopes = ['account', 'repository:write', 'pullrequest', 'webhook'];
  credential.credential_version = 1;
  expect(await getBitbucketWorkspaceAccessTokenStatus(authorization.owner.id)).toMatchObject({
    status: 'connected',
    integrationId: row.integrationId,
    reviewPermissions: { readReady: true, writeReady: false, recoveryAction: 'replace_token' },
    repositoryCache: {
      status: 'available',
      repositories: [{ fullName: 'team/repo', defaultBranch: 'trunk' }],
    },
  });
});

it.each(
  (['source', 'destination'] as const).flatMap(endpoint =>
    (['branch', 'repository', 'workspace'] as const).flatMap(field =>
      (['immediate', 'task', 'lost response'] as const).map(mode => ({ endpoint, field, mode }))
    )
  )
)(
  'AC7 keeps same-SHA $endpoint $field drift unresolved through $mode',
  async ({ endpoint, field, mode }) => {
    const changeIdentity = () => {
      if (field === 'branch') pr[endpoint].branch = { name: 'different' };
      else
        pr[endpoint].repository = {
          ...pr[endpoint].repository,
          ...(field === 'repository'
            ? { uuid: '{77777777-7777-4777-8777-777777777777}' }
            : { workspace: { uuid: '{88888888-8888-4888-8888-888888888888}' } }),
        };
    };
    pendingMerge = mode === 'task';
    lostResponse = mode === 'lost response';
    if (mode === 'immediate') afterWrite = changeIdentity;
    const input: ReviewIntentInput = { action: 'merge', method: 'merge_commit' };
    let result = await run(input);
    if (mode !== 'immediate') {
      expect(result.status).toBe(mode === 'task' ? 'accepted' : 'unresolved');
      changeIdentity();
      lostResponse = false;
      taskState = 'SUCCESS';
      result = await run(input, true);
    }
    expect(result).toMatchObject({ status: 'unresolved', retry: 'reconcile' });
    await run(input);
    expect(events).toEqual(['merge']);
    expect(merges).toHaveLength(1);
  }
);

it.each(['comment', 'approve', 'merge'] as const)(
  'AC6/AC7 resolves an abbreviated fork head for %s without a destination commit',
  async action => {
    const fork = {
      ...repository,
      repositoryId: '77777777-7777-4777-8777-777777777777',
      workspaceUuid: '88888888-8888-4888-8888-888888888888',
      fullName: 'contributor/fork',
    };
    overview.source.repository = fork;
    pr.source.repository = {
      uuid: `{${fork.repositoryId}}`,
      full_name: fork.fullName,
      workspace: { uuid: `{${fork.workspaceUuid}}` },
    };
    pr.source.commit.hash = revision.headSha.slice(0, 12);
    sourceInDestination = false;
    const input: ReviewIntentInput =
      action === 'comment'
        ? { action, body: 'Fork review' }
        : action === 'merge'
          ? { action, method: 'merge_commit' }
          : { action };
    expect(await run(input)).toMatchObject(
      action === 'merge'
        ? { status: 'confirmed', reference: { kind: 'review', id: '7' } }
        : { status: 'unresolved', reason: 'no_atomic_revision_guard' }
    );
    if (action === 'comment') expect(comments[1].content.raw).toBe('Fork review');
    if (action === 'approve') expect(state).toBe('approved');
    if (action === 'merge') expect(pr.state).toBe('MERGED');
    await run(input);
    expect(events).toHaveLength(1);
  }
);

it.each([
  'different full SHA',
  'ambiguous prefix',
  'missing fork evidence',
  'abbreviated evidence',
] as const)(
  'AC6 refuses %s instead of treating a source prefix as a full revision',
  async condition => {
    const other = `${revision.headSha.slice(0, 12)}${'c'.repeat(28)}`;
    pr.source.commit.hash = revision.headSha.slice(0, 12);
    sourceCommits =
      condition === 'different full SHA'
        ? [other]
        : condition === 'ambiguous prefix'
          ? [revision.headSha, other]
          : condition === 'abbreviated evidence'
            ? [pr.source.commit.hash]
            : [];
    if (condition === 'missing fork evidence') {
      const fork = {
        ...repository,
        repositoryId: '77777777-7777-4777-8777-777777777777',
        fullName: 'team/fork',
      };
      overview.source.repository = fork;
      pr.source.repository = {
        ...nativeRepo,
        uuid: `{${fork.repositoryId}}`,
        full_name: fork.fullName,
      };
      sourceInDestination = false;
    }
    expect(await run({ action: 'comment', body: 'Preserved draft' })).toMatchObject({
      status: 'rejected',
      code:
        condition === 'different full SHA'
          ? 'conflict'
          : condition === 'abbreviated evidence'
            ? 'invalid_response'
            : 'temporarily_unavailable',
      retry:
        condition === 'different full SHA' || condition === 'abbreviated evidence'
          ? 'never'
          : 'same-key',
    });
    expect(events).toEqual([]);
    expect(comments.map(value => value.content.raw)).toEqual(['Original']);
  }
);

it.each([false, true])(
  'AC6 resolves a later fork commit page or retains its retryable failure: %s',
  async failPage => {
    const fork = {
      ...repository,
      repositoryId: '77777777-7777-4777-8777-777777777777',
      fullName: 'team/fork',
    };
    overview.source.repository = fork;
    pr.source.repository = {
      ...nativeRepo,
      uuid: `{${fork.repositoryId}}`,
      full_name: fork.fullName,
    };
    pr.source.commit.hash = revision.headSha.slice(0, 12);
    sourceInDestination = false;
    const next = `${taskUrl.split('/merge/')[0]}/commits?pagelen=50&page=2`;
    const execute = auth.client.execute;
    auth.client.execute = async input => {
      if (input.operation !== 'commits') return execute(input);
      if (input.next && failPage)
        throw new BitbucketInteractiveClientError('temporarily_unavailable');
      return {
        status: 200,
        data: { values: [{ hash: input.next ? revision.headSha : revision.targetHeadSha }] },
        ...(input.next ? {} : { next }),
        metadata: {},
      } as any;
    };
    expect(await run({ action: 'comment', body: 'Paged fork review' })).toMatchObject(
      failPage
        ? { status: 'rejected', code: 'temporarily_unavailable', retry: 'same-key' }
        : { status: 'unresolved', reason: 'no_atomic_revision_guard', reference: { id: '2' } }
    );
    expect(comments.map(value => value.content.raw)).toEqual(
      failPage ? ['Original'] : ['Original', 'Paged fork review']
    );
  }
);

it('AC6 preserves closed same-repository comments when the source branch and commit list are absent', async () => {
  pr.state = 'MERGED';
  pr.source.branch = null;
  pr.source.commit.hash = revision.headSha.slice(0, 12);
  overview.state = 'merged';
  overview.source.branch = null;
  sourceCommits = [];
  expect(await run({ action: 'comment', body: 'Closed review' })).toMatchObject({
    status: 'unresolved',
    reason: 'no_atomic_revision_guard',
    reference: { id: '2' },
  });
  expect(comments.map(value => value.content.raw)).toEqual(['Original', 'Closed review']);
});

const canonicalTaskUrl =
  'https://api.bitbucket.org/2.0/repositories/team/repo/pullrequests/7/merge/task-status/task-1';

it('AC7 retains canonical 202 task locations through the production SDK', async () => {
  pendingMerge = true;
  taskLocation = canonicalTaskUrl;
  taskSelf = canonicalTaskUrl;
  const input: ReviewIntentInput = { action: 'merge', method: 'merge_commit' };
  const result = await run(input);
  expect(events).toEqual(['merge']);
  expect(result).toMatchObject({
    status: 'accepted',
    reference: { id: 'task-1', url: canonicalTaskUrl },
    task: { state: 'pending' },
  });
  taskState = 'SUCCESS';
  expect(await run(input, true)).toMatchObject({ status: 'confirmed' });
  expect(merges).toHaveLength(1);
});

it('AC7 polls documented canonical task self links after a UUID-addressed merge', async () => {
  pendingMerge = true;
  taskSelf = canonicalTaskUrl;
  const input: ReviewIntentInput = { action: 'merge', method: 'merge_commit' };
  expect(await run(input)).toMatchObject({ status: 'accepted', reference: { url: taskUrl } });
  expect(await run(input, true)).toMatchObject({ status: 'accepted', task: { state: 'pending' } });
  taskState = 'SUCCESS';
  expect(await run(input, true)).toMatchObject({ status: 'confirmed' });
  expect(pr.state).toBe('MERGED');
  expect(events).toEqual(['merge']);
});

it.each([
  ['origin', canonicalTaskUrl.replace('api.bitbucket.org', 'example.com')],
  ['scheme', canonicalTaskUrl.replace('https:', 'http:')],
  ['port', canonicalTaskUrl.replace('.org/', '.org:8443/')],
  ['credentials', canonicalTaskUrl.replace('https://', 'https://user@')],
  ['workspace', canonicalTaskUrl.replace('/team/', '/other/')],
  ['repository', canonicalTaskUrl.replace('/repo/', '/other/')],
  ['review', canonicalTaskUrl.replace('/7/', '/8/')],
  ['task', canonicalTaskUrl.replace('task-1', 'task-2')],
  ['query', `${canonicalTaskUrl}?other=1`],
  ['fragment', `${canonicalTaskUrl}#other`],
  ['encoded slash', `${canonicalTaskUrl}%2Fother`],
  ['extra path', `${canonicalTaskUrl}/other`],
])('AC7 rejects a canonical task link with a different %s', async (_field, self) => {
  pendingMerge = true;
  const input: ReviewIntentInput = { action: 'merge', method: 'merge_commit' };
  await run(input);
  taskSelf = self;
  taskState = 'SUCCESS';
  expect(await run(input, true)).toMatchObject({ status: 'unresolved', retry: 'reconcile' });
  expect([...records.values()][0].result).toMatchObject({
    status: 'accepted',
    reference: { id: 'task-1' },
  });
  await run(input);
  expect(events).toEqual(['merge']);
});
