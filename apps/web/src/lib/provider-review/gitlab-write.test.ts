jest.mock('@/lib/drizzle', () => ({ db: {} }));
jest.mock('@/lib/integrations/gitlab-service', () => ({ getGitLabIntegration: jest.fn() }));
jest.mock('@/lib/integrations/platforms/gitlab/credential-broker-client', () => ({
  fetchGitLabCredential: jest.fn(),
}));
jest.mock('./gitlab-read', () => ({ getGitLabReview: jest.fn(), listGitLabFiles: jest.fn() }));
jest.mock('./operation', () => ({
  ...jest.requireActual('./operation'),
  runReviewOperation: jest.fn(),
}));

import { buildSchema, graphql } from 'graphql';
import {
  createGitLabInteractiveClient,
  GitLabInteractiveError,
} from '@/lib/integrations/platforms/gitlab/interactive-client';
import { fetchGitLabCredential } from '@/lib/integrations/platforms/gitlab/credential-broker-client';
import { repositoryResourceKey } from '@kilocode/app-shared/code-review/repository-identity';
import {
  providerReviewIntentFingerprint,
  type ReviewIntentInput,
  type ReviewOverview,
  type ReviewPosition,
} from '@kilocode/app-shared/provider-review';
import { reviewCapabilityFixtures } from '@kilocode/app-shared/provider-review/fixtures';
import type { GitLabReviewAuthorization } from './gitlab-authorization';
import { getGitLabReview, listGitLabFiles } from './gitlab-read';
import {
  rejectedReviewEffect,
  reviewEffectOperationKey,
  runReviewOperation,
  type ReviewEffectResult,
  type ReviewOperationRequest,
} from './operation';
import { runGitLabReviewOperation } from './gitlab-write';

const userId = 'oauth/caller',
  instanceUrl = 'https://gitlab.com/GitLab';
const authorization = {
  kind: 'ownerIntegration' as const,
  integrationId: '11111111-1111-4111-8111-111111111111',
  owner: { type: 'user' as const, id: userId },
};
const repository = {
  provider: 'gitlab' as const,
  instanceUrl,
  repositoryId: '123',
  fullName: 'Group/Sub/Repo',
  defaultBranch: 'trunk',
};
const identity = {
  repository,
  authorization,
  reviewId: '77',
  number: '7',
  canonicalUrl: `${instanceUrl}/${repository.fullName}/-/merge_requests/7`,
};
const revision = {
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  startSha: 'c'.repeat(40),
  targetHeadSha: null,
};
const position: ReviewPosition = {
  revision,
  oldPath: 'old.ts',
  newPath: 'new.ts',
  side: 'new',
  line: 3,
  startSide: 'new',
  startLine: 2,
  native: {
    provider: 'gitlab',
    oldLine: null,
    newLine: 3,
    lineRange: {
      start: { lineCode: 'line-2', side: 'new', oldLine: null, newLine: 2 },
      end: { lineCode: 'line-3', side: 'new', oldLine: null, newLine: 3 },
    },
  },
};
const nativePosition = {
  position_type: 'text',
  head_sha: revision.headSha,
  base_sha: revision.baseSha,
  start_sha: revision.startSha,
  old_path: 'old.ts',
  new_path: 'new.ts',
  new_line: 3,
  old_line: null,
  line_range: {
    start: { line_code: 'line-2', type: 'new', new_line: 2 },
    end: { line_code: 'line-3', type: 'new', new_line: 3 },
  },
};
const root = '/projects/123/merge_requests/7';
const actor = { id: 9, username: 'integration-actor' };
const note = {
  id: 8,
  body: 'Original',
  author: actor,
  noteable_id: 77,
  resolvable: true,
  resolved: false,
  current_user: { can_resolve: true },
};
const project = {
  id: 123,
  path_with_namespace: repository.fullName,
  web_url: `${instanceUrl}/${repository.fullName}`,
  default_branch: 'trunk',
  merge_method: 'ff',
  squash_option: 'always',
  permissions: { project_access: { access_level: 40 } },
};
const baseReview = {
  id: 77,
  iid: 7,
  project_id: 123,
  target_project_id: 123,
  source_project_id: 123,
  web_url: identity.canonicalUrl,
  state: 'opened',
  squash: false,
  user: { can_merge: true },
  sha: revision.headSha,
  diff_refs: {
    head_sha: revision.headSha,
    base_sha: revision.baseSha,
    start_sha: revision.startSha,
  },
  source_branch: 'feature',
  target_branch: 'trunk',
  merge_when_pipeline_succeeds: false,
  rebase_in_progress: false,
  merge_error: null as string | null,
};
let auth: GitLabReviewAuthorization;
let review: typeof baseReview;
let overview: ReviewOverview;
let notes: (typeof note)[];
let awards: { id: number; name: string; user: typeof actor }[];
let writes: { path: string; body: any; method: string }[];
let failures: Map<string, number>;
let version: string;
let branch: {
  name: string;
  default: boolean;
  protected: boolean;
  can_push: boolean;
  commit: { id: string };
};
let branchExists: boolean;
let drafts: Set<string>;
let draftDiscussion: { discussion_id: string | null; resolve_discussion: boolean };
let requestedChanges: boolean;
let loseResponse: string | undefined;
let acceptedResponse: string | undefined;
let failReadAfterWrite: boolean;
let beforeWrite: (() => void) | undefined;
let providerActor: typeof actor;
let records: Map<string, { fingerprint: string; result?: ReviewEffectResult }>;
const request = (input: ReviewIntentInput): ReviewOperationRequest => ({
  userId,
  distinctId: 'caller@example.com',
  operationKey: '22222222-2222-4222-8222-222222222222',
  intent: { accountId: userId, actorId: '9', review: identity, revision, input },
});
const run = (input: ReviewIntentInput) => runGitLabReviewOperation(auth, request(input));
const graph =
  buildSchema(`type Query { unused: Boolean } input MergeRequestRequestChangesInput { projectPath: ID!, iid: String! }
  type MergeRequest { id: ID!, iid: String! } type Payload { mergeRequest: MergeRequest, errors: [String!]! }
  type Mutation { mergeRequestRequestChanges(input: MergeRequestRequestChangesInput!): Payload }`);

beforeEach(() => {
  jest.resetAllMocks();
  review = structuredClone(baseReview);
  project.merge_method = 'ff';
  project.squash_option = 'always';
  notes = [structuredClone(note)];
  awards = [];
  writes = [];
  failures = new Map();
  version = '17.11.0';
  branch = {
    name: 'feature',
    default: false,
    protected: false,
    can_push: true,
    commit: { id: revision.headSha },
  };
  branchExists = true;
  drafts = new Set(['11']);
  draftDiscussion = { discussion_id: null, resolve_discussion: false };
  requestedChanges = false;
  loseResponse = undefined;
  acceptedResponse = undefined;
  failReadAfterWrite = false;
  beforeWrite = undefined;
  providerActor = actor;
  records = new Map();
  auth = {
    userId,
    authorization,
    instanceUrl,
    actor: {
      provider: 'gitlab',
      instanceUrl,
      id: '9',
      login: actor.username,
      displayName: null,
      avatarUrl: null,
    },
    credentialKind: 'gitlabPat',
    scopes: ['api'],
    projectTokenId: undefined,
    client: projectId =>
      createGitLabInteractiveClient({
        actor: { userId },
        selector: { credential: 'integration', integrationId: authorization.integrationId },
        instanceUrl,
        scope: projectId ? { kind: 'project', projectId } : { kind: 'discovery' },
      }),
  };
  overview = {
    identity,
    title: 'Review',
    bodyMarkdown: null,
    author: auth.actor,
    state: 'open',
    draft: false,
    revision,
    source: { repository, branch: 'feature' },
    target: { repository, branch: 'trunk' },
    authorization: {
      actor: auth.actor,
      credentialKind: auth.credentialKind,
      capabilities: reviewCapabilityFixtures('gitlab'),
      writeLimits: { requestMaxBytes: 256_000, bodyMaxBytes: null },
    },
    providerState: {
      provider: 'gitlab',
      approvals: { approved: false, required: 0, remaining: 0, actorIds: [] },
      requestedChanges: {
        actorIds: [],
        blocksMerge: false,
        blockingCapability: {
          ...reviewCapabilityFixtures('gitlab').requestChanges,
          license: 'unavailable',
        },
      },
    },
    checks: { status: 'none', checks: [] },
    counts: { commits: 1, files: 1, additions: 3, deletions: 1 },
    merge: {
      methods: [{ id: 'ff', label: 'ff' }],
      squash: 'required',
      autoMerge: null,
      task: null,
    },
  };
  jest.mocked(getGitLabReview).mockImplementation(async () => ({
    ...overview,
    state: review.state === 'merged' ? 'merged' : overview.state,
    revision: { ...revision, headSha: review.sha },
  }));
  jest.mocked(listGitLabFiles).mockResolvedValue({
    items: [
      {
        id: 'file',
        oldPath: 'old.ts',
        newPath: 'new.ts',
        revision,
        status: 'renamed',
        patch: '@@ -1,3 +1,3 @@',
        content: 'available',
        additions: 3,
        deletions: 1,
        canonicalUrl: identity.canonicalUrl,
      },
    ],
    nextCursor: null,
  });
  jest.mocked(fetchGitLabCredential).mockResolvedValue({
    status: 'available',
    token: 'fixture-token',
    instanceUrl,
    glabIsOAuth2: false,
  });
  // The ledger suite tests admission/CAS. This fake preserves its contract for protocol and batch tests.
  jest.mocked(runReviewOperation).mockImplementation(async (input, handlers) => {
    const key = reviewEffectOperationKey(input.operationKey, input.effect?.id),
      fingerprint = providerReviewIntentFingerprint(input.intent),
      old = records.get(key);
    if (old && old.fingerprint !== fingerprint)
      return rejectedReviewEffect('operation_key_reuse_mismatch');
    if (
      old?.result?.status === 'confirmed' ||
      (old?.result?.status === 'rejected' && old.result.retry === 'never')
    )
      return old.result;
    if (!old && !handlers.execute)
      return rejectedReviewEffect('operation_not_admitted', 'same-key');
    const value = old ?? { fingerprint };
    records.set(key, value);
    const result =
      handlers.execute &&
      (!old || (old.result?.status === 'rejected' && old.result.retry === 'same-key'))
        ? await handlers.execute()
        : await handlers.reconcile(old?.result ?? null);
    // An unavailable status read does not erase durable acceptance evidence.
    if (value.result?.status !== 'accepted' || result.status !== 'unresolved')
      value.result = result;
    return result;
  });
  global.fetch = jest.fn(async (destination, init) => {
    const url = new URL(String(destination)),
      path = url.pathname.replace('/GitLab/api/v4', '');
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      if (failReadAfterWrite && writes.length) return Response.json({}, { status: 403 });
      if (path === '/metadata') return Response.json({ version, enterprise: false });
      if (path === '/projects/123') return Response.json(project);
      if (path === root) return Response.json(review);
      if (path.startsWith(`${root}/notes/`) && /^\d+$/.test(path.slice(`${root}/notes/`.length))) {
        const found = notes.find(item => String(item.id) === path.slice(`${root}/notes/`.length));
        return Response.json(found ?? {}, { status: found ? 200 : 404 });
      }
      if (path === `${root}/approvals`)
        return Response.json({
          approved_by:
            overview.providerState.provider === 'gitlab' &&
            overview.providerState.approvals.actorIds.includes('9')
              ? [{ user: actor }]
              : [],
        });
      if (path === `${root}/reviewers`)
        return Response.json([
          { user: actor, state: requestedChanges ? 'requested_changes' : 'unreviewed' },
        ]);
      if (path === `${root}/discussions/thread`) return Response.json({ id: 'thread', notes });
      if (path === `${root}/notes/8/award_emoji`)
        return Response.json(awards, { headers: { 'x-next-page': '' } });
      if (path === '/projects/123/repository/branches/feature')
        return branchExists ? Response.json(branch) : Response.json({}, { status: 404 });
      // Response fields: https://docs.gitlab.com/api/draft_notes/#get-a-single-draft-note
      if (path === `${root}/draft_notes/11` && drafts.has('11'))
        return Response.json({
          id: 11,
          author_id: 9,
          merge_request_id: 77,
          ...draftDiscussion,
          note: 'Draft',
          position: nativePosition,
        });
      return Response.json({}, { status: 404 });
    }
    const incoming = new Request(String(destination), init);
    const body = !init?.body
      ? {}
      : incoming.headers.get('content-type')?.startsWith('multipart/form-data')
        ? Object.fromEntries(await incoming.formData())
        : await incoming.json();
    beforeWrite?.();
    const failure = failures.get(`${method} ${path}`);
    if (failure) return Response.json({}, { status: failure });
    let response: Response;
    if (path === `${root}/notes` && method === 'POST') {
      const value = { ...note, id: notes.length + 40, body: body.body, author: providerActor };
      notes.push(value);
      response = Response.json(value, { status: 201 });
    } else if (path === `${root}/discussions` && method === 'POST') {
      const p = body.position ?? {
        position_type: body['position[position_type]'],
        head_sha: body['position[head_sha]'],
        base_sha: body['position[base_sha]'],
        start_sha: body['position[start_sha]'],
        old_path: body['position[old_path]'],
        new_path: body['position[new_path]'],
        old_line: body['position[old_line]'] ? Number(body['position[old_line]']) : null,
        new_line: body['position[new_line]'] ? Number(body['position[new_line]']) : null,
        ...(body['position[line_range][start][line_code]']
          ? {
              line_range: {
                start: {
                  line_code: body['position[line_range][start][line_code]'],
                  type: body['position[line_range][start][type]'],
                  new_line: Number(body['position[line_range][start][new_line]']),
                },
                end: {
                  line_code: body['position[line_range][end][line_code]'],
                  type: body['position[line_range][end][type]'],
                  new_line: Number(body['position[line_range][end][new_line]']),
                },
              },
            }
          : {}),
      };
      if (
        p.head_sha !== revision.headSha ||
        p.base_sha !== revision.baseSha ||
        p.start_sha !== revision.startSha ||
        p.old_path !== 'old.ts' ||
        p.new_path !== 'new.ts'
      )
        return Response.json({}, { status: 400 });
      const value = {
        ...note,
        id: notes.length + 40,
        body: body.body,
        author: providerActor,
        position: p,
      };
      notes.push(value);
      response = Response.json({ id: 'new-thread', notes: [value] }, { status: 201 });
    } else if (path === `${root}/discussions/thread/notes` && method === 'POST') {
      const value = { ...note, id: notes.length + 40, body: body.body };
      notes.push(value);
      response = Response.json(value, { status: 201 });
    } else if (path === `${root}/discussions/thread` && method === 'PUT') {
      const resolved = url.searchParams.get('resolved');
      if (resolved !== 'true' && resolved !== 'false') return Response.json({}, { status: 400 });
      notes[0].resolved = resolved === 'true';
      response = Response.json({ id: 'thread', notes: [notes[0]] });
    } else if (path === `${root}/notes/8/award_emoji` && method === 'POST') {
      const value = { id: 20, name: body.name, user: providerActor };
      awards.push(value);
      response = Response.json(value, { status: 201 });
    } else if (path === `${root}/notes/8/award_emoji/20` && method === 'DELETE') {
      awards = [];
      response = new Response(null, { status: 204 });
    } else if (path === `${root}/approve` && method === 'POST') {
      if (body.sha !== review.sha) return Response.json({}, { status: 409 });
      overview.providerState = {
        ...overview.providerState,
        provider: 'gitlab',
        approvals: { approved: true, required: 0, remaining: 0, actorIds: ['9'] },
        requestedChanges: (
          overview.providerState as Extract<ReviewOverview['providerState'], { provider: 'gitlab' }>
        ).requestedChanges,
      };
      response = Response.json({ approved_by: [{ user: providerActor }] });
    } else if (path === `${root}/unapprove` && method === 'POST') {
      if (overview.providerState.provider === 'gitlab')
        overview.providerState.approvals.actorIds = [];
      response = new Response(null, { status: 204 });
    } else if (url.pathname === '/GitLab/api/graphql' && method === 'POST') {
      response = Response.json(
        await graphql({
          schema: graph,
          source: body.query,
          variableValues: body.variables,
          rootValue: {
            mergeRequestRequestChanges: ({
              input,
            }: {
              input: { projectPath: string; iid: string };
            }) => {
              if (input.projectPath !== repository.fullName || input.iid !== '7')
                return { mergeRequest: null, errors: ['Wrong target'] };
              requestedChanges = true;
              return { mergeRequest: { id: 'gid://gitlab/MergeRequest/77', iid: '7' }, errors: [] };
            },
          },
        })
      );
    } else if (path === `${root}/merge` && method === 'PUT') {
      if (body.sha !== review.sha) return Response.json({}, { status: 409 });
      if (
        (project.squash_option === 'always' && body.squash !== true) ||
        (project.squash_option === 'never' && body.squash !== false) ||
        body.should_remove_source_branch !== false
      )
        return Response.json({}, { status: 400 });
      review.squash = body.squash;
      if (body.auto_merge || body.merge_when_pipeline_succeeds) {
        if (version === '17.10.0' ? body.auto_merge : body.merge_when_pipeline_succeeds)
          return Response.json({}, { status: 400 });
        review.merge_when_pipeline_succeeds = true;
      } else if (acceptedResponse !== path) review.state = 'merged';
      response = Response.json(review);
    } else if (path === `${root}/cancel_merge_when_pipeline_succeeds` && method === 'POST') {
      review.merge_when_pipeline_succeeds = false;
      response = Response.json(review);
    } else if (path === `${root}/rebase` && method === 'PUT') {
      review.rebase_in_progress = true;
      response = Response.json({ rebase_in_progress: true }, { status: 202 });
    } else if (path === '/projects/123/repository/branches/feature' && method === 'DELETE') {
      branchExists = false;
      response = new Response(null, { status: 204 });
    } else if (path === `${root}/draft_notes/11/publish` && method === 'PUT') {
      drafts.delete('11');
      notes.push({ ...note, id: 11, body: 'Draft' });
      // https://raw.githubusercontent.com/gitlabhq/gitlabhq/v17.11.0/app/services/draft_notes/publish_service.rb
      if (draftDiscussion.discussion_id) notes[0].resolved = draftDiscussion.resolve_discussion;
      response = new Response(null, { status: 204 });
    } else return Response.json({}, { status: 404 });
    writes.push({ path, body, method });
    if (loseResponse === path) throw new Error('Connection lost with fixture-token');
    if (acceptedResponse === path) {
      const text = await response.text();
      return Response.json(text ? JSON.parse(text) : {}, { status: 202 });
    }
    return response;
  });
});

it.each(['user', 'org'] as const)(
  'AC6 writes as the authorized GitLab actor for %s ownership',
  async owner => {
    const input = request({ action: 'comment', body: 'Comment' });
    if (owner === 'org') {
      auth.authorization = {
        ...authorization,
        owner: { type: 'org', id: '33333333-3333-4333-8333-333333333333' },
      };
      input.intent.review = { ...identity, authorization: auth.authorization };
      overview.identity = input.intent.review;
    }
    expect(await runGitLabReviewOperation(auth, input)).toMatchObject({
      status: 'confirmed',
      reference: { provider: 'gitlab', kind: 'comment' },
    });
    expect(notes.at(-1)).toMatchObject({ body: 'Comment', author: actor, noteable_id: 77 });
    expect(writes).toHaveLength(1);
  }
);
it('AC6 preserves inline old/new paths, immutable refs, side, and range through the real SDK', async () => {
  expect(await run({ action: 'inlineComment', body: 'Inline', position })).toMatchObject({
    status: 'confirmed',
  });
  expect(notes.at(-1)).toMatchObject({ body: 'Inline', position: nativePosition });
});
it('AC6 rejects stale SHA before dispatch and preserves the original position', async () => {
  review.sha = 'd'.repeat(40);
  review.diff_refs.head_sha = review.sha;
  expect(await run({ action: 'inlineComment', body: 'Stale', position })).toMatchObject({
    status: 'rejected',
    code: 'conflict',
    retry: 'never',
  });
  expect(writes).toEqual([]);
  expect(position.revision).toEqual(revision);
});
it('AC6 rejects a mismatched actor without changing the provider', async () => {
  const input = request({ action: 'comment', body: 'Wrong actor' });
  input.intent.actorId = '10';
  expect(await runGitLabReviewOperation(auth, input)).toMatchObject({
    status: 'rejected',
    code: 'operation_identity_mismatch',
  });
  expect(notes).toHaveLength(1);
  expect(writes).toEqual([]);
});
it('AC6 keeps lost comment responses unresolved without body-based replay', async () => {
  loseResponse = `${root}/notes`;
  const input = { action: 'comment' as const, body: 'Once' };
  expect(await run(input)).toMatchObject({ status: 'unresolved', retry: 'reconcile' });
  expect(await run(input)).toMatchObject({ status: 'unresolved', retry: 'reconcile' });
  expect(notes.filter(value => value.body === 'Once')).toHaveLength(1);
  expect(writes).toHaveLength(1);
});
it('AC6 reconciles a saved comment after a failed postflight read without replay', async () => {
  failReadAfterWrite = true;
  const input: ReviewIntentInput = { action: 'comment', body: 'Saved' };
  expect(await run(input)).toMatchObject({
    status: 'unresolved',
    reference: { id: '41' },
    retry: 'reconcile',
  });
  expect(notes.at(-1)?.body).toBe('Saved');
  failReadAfterWrite = false;
  expect(await run(input)).toMatchObject({ status: 'confirmed', reference: { id: '41' } });
  expect(writes).toHaveLength(1);
});
it.each(['comment', 'approve', 'merge', 'requestChanges'] as const)(
  'AC6/AC7 blocks %s with denied write grants',
  async action => {
    auth.scopes = ['read_api'];
    expect(
      await run(
        action === 'comment'
          ? { action, body: 'Denied' }
          : action === 'merge'
            ? { action, method: 'ff' }
            : { action }
      )
    ).toMatchObject({ status: 'rejected', code: 'forbidden' });
    expect(writes).toEqual([]);
  }
);
it.each(['reply', 'resolveThread', 'reopenThread'] as const)(
  'AC6 supports %s on the exact discussion',
  async action => {
    notes[0].resolved = action === 'reopenThread';
    expect(
      await run({
        action,
        target: {
          provider: 'gitlab',
          kind: 'thread',
          id: 'thread',
          url: `${identity.canonicalUrl}#note_8`,
        },
        ...(action === 'reply' ? { body: 'Reply' } : {}),
      })
    ).toMatchObject({ status: 'confirmed' });
    if (action === 'reply') expect(notes.at(-1)?.body).toBe('Reply');
    else expect(notes[0].resolved).toBe(action === 'resolveThread');
  }
);
it.each(['addReaction', 'removeReaction'] as const)(
  'AC6 supports %s for the actual provider actor',
  async action => {
    if (action === 'removeReaction') awards.push({ id: 20, name: 'thumbsup', user: actor });
    expect(
      await run({
        action,
        target: { provider: 'gitlab', kind: 'comment', id: '8', url: null },
        reaction: action === 'addReaction' ? 'thumbsup' : '20',
      })
    ).toMatchObject({ status: 'confirmed' });
    expect(awards).toEqual(
      action === 'addReaction' ? [{ id: 20, name: 'thumbsup', user: actor }] : []
    );
  }
);
it('AC6 refuses removal of another actor reaction', async () => {
  awards.push({ id: 20, name: 'thumbsup', user: { ...actor, id: 10 } });
  expect(
    await run({
      action: 'removeReaction',
      target: { provider: 'gitlab', kind: 'comment', id: '8', url: null },
      reaction: '20',
    })
  ).toMatchObject({ status: 'rejected', code: 'forbidden' });
  expect(awards).toHaveLength(1);
  expect(writes).toEqual([]);
});
it.each(['approve', 'unapprove'] as const)('AC6 supports %s without GitHub calls', async action => {
  expect(await run({ action })).toMatchObject({ status: 'confirmed' });
  expect(overview.providerState).toMatchObject({
    approvals: { actorIds: action === 'approve' ? ['9'] : [] },
  });
});
it('AC6 enforces the provider approval SHA guard after a preflight race', async () => {
  beforeWrite = () => {
    review.sha = 'd'.repeat(40);
    review.diff_refs.head_sha = review.sha;
  };
  expect(await run({ action: 'approve' })).toMatchObject({ status: 'rejected', code: 'conflict' });
  expect(overview.providerState).toMatchObject({ approvals: { actorIds: [] } });
});
it('AC6 requests changes through authorized GraphQL without licensed merge blocking', async () => {
  overview.authorization.capabilities.requestChanges.version = 'unknown';
  expect(await run({ action: 'requestChanges' })).toMatchObject({ status: 'confirmed' });
  expect(requestedChanges).toBe(true);
  expect(overview.providerState).toMatchObject({ requestedChanges: { blocksMerge: false } });
});
it('AC6 keeps publication, summary, and approval separate after partial failure', async () => {
  const input: ReviewIntentInput = {
    action: 'submitReview',
    comments: [
      { itemId: '11', body: 'Draft', position },
      { itemId: 'second', body: 'Second', position },
    ],
    draftReferences: [
      { provider: 'gitlab', kind: 'comment', id: '11', url: identity.canonicalUrl },
    ],
    body: 'Summary',
    choice: 'approve',
  };
  failures.set(`POST ${root}/discussions`, 429);
  const partial = await run(input);
  expect(partial).toMatchObject({
    status: 'partial',
    items: [
      { result: { status: 'confirmed' } },
      { result: { status: 'rejected', retry: 'same-key' } },
      { result: { code: 'previous_effect_unconfirmed' } },
      { result: { code: 'previous_effect_unconfirmed' } },
    ],
  });
  expect(drafts.size).toBe(0);
  expect(notes.map(value => value.body)).toEqual(['Original', 'Draft']);
  failures.clear();
  expect(await run(input)).toMatchObject({ status: 'confirmed' });
  expect(notes.map(value => value.body)).toEqual(['Original', 'Draft', 'Second', 'Summary']);
  expect(writes.filter(value => value.path.endsWith('/publish'))).toHaveLength(1);
  expect(overview.providerState).toMatchObject({ approvals: { actorIds: ['9'] } });
  expect(input.comments?.[1].position).toEqual(position);
});
it('AC6 keeps an empty review empty without dispatching content or approval', async () => {
  expect(await run({ action: 'submitReview', comments: [], choice: 'comment' })).toMatchObject({
    status: 'confirmed',
    reference: null,
  });
  expect(writes).toEqual([]);
  expect(notes).toHaveLength(1);
});
it.each(['17.10.0', '17.11.0', '18.0.0'])(
  'AC7/AC10 uses the authorized %s auto-merge form',
  async instanceVersion => {
    version = instanceVersion;
    expect(await run({ action: 'enableAutoMerge', method: 'ff', squash: true })).toMatchObject({
      status: 'confirmed',
    });
    expect(review.merge_when_pipeline_succeeds).toBe(true);
    expect(review.state).toBe('opened');
    expect(branchExists).toBe(true);
  }
);
it('AC7 cancels auto-merge and reconciles accepted rebase progress', async () => {
  review.merge_when_pipeline_succeeds = true;
  expect(await run({ action: 'disableAutoMerge' })).toMatchObject({ status: 'confirmed' });
  expect(review.merge_when_pipeline_succeeds).toBe(false);
  const rebase = request({ action: 'updateBranch' });
  rebase.operationKey = '44444444-4444-4444-8444-444444444444';
  expect(await runGitLabReviewOperation(auth, rebase)).toMatchObject({
    status: 'accepted',
    retry: 'reconcile',
  });
  expect(await runGitLabReviewOperation(auth, rebase, true)).toMatchObject({ status: 'accepted' });
  review.rebase_in_progress = false;
  review.sha = 'd'.repeat(40);
  review.diff_refs.head_sha = review.sha;
  expect(await runGitLabReviewOperation(auth, rebase, true)).toMatchObject({ status: 'confirmed' });
  expect(writes.filter(value => value.path.endsWith('/rebase'))).toHaveLength(1);
});
it.each(['method', 'squash', 'restriction', 'empty'] as const)(
  'AC7 rejects invalid %s before merge',
  async kind => {
    const input: ReviewIntentInput = { action: 'merge', method: 'ff', squash: true };
    if (kind === 'method') input.method = 'rebase';
    if (kind === 'squash') input.squash = false;
    if (kind === 'restriction')
      overview.authorization.capabilities.merge.restrictions = ['pipeline_not_successful'];
    if (kind === 'empty') overview.merge.methods = [];
    expect(await run(input)).toMatchObject({ status: 'rejected', code: 'conflict' });
    expect(review.state).toBe('opened');
    expect(writes).toEqual([]);
  }
);
it('AC7 reconciles a lost merge response by exact source SHA without merging twice', async () => {
  loseResponse = `${root}/merge`;
  const input: ReviewIntentInput = { action: 'merge', method: 'ff', squash: true };
  expect(await run(input)).toMatchObject({ status: 'unresolved' });
  expect(review.state).toBe('merged');
  expect(await run(input)).toMatchObject({ status: 'confirmed' });
  expect(writes).toHaveLength(1);
});
it('AC7 preserves confirmed merge separately from denied source deletion', async () => {
  failures.set('DELETE /projects/123/repository/branches/feature', 403);
  const input: ReviewIntentInput = {
    action: 'merge',
    method: 'ff',
    deletion: {
      effect: 'delete',
      repositoryKey: repositoryResourceKey(userId, identity),
      branch: 'feature',
      expectedHeadSha: revision.headSha,
    },
  };
  expect(await run(input)).toMatchObject({
    status: 'partial',
    items: [
      { result: { status: 'confirmed' } },
      { result: { status: 'rejected', code: 'forbidden' } },
    ],
  });
  expect(review.state).toBe('merged');
  expect(branchExists).toBe(true);
  await run(input);
  expect(writes.filter(value => value.path.endsWith('/merge'))).toHaveLength(1);
});
it('AC7 deletes only the server-derived source after confirmed merge', async () => {
  expect(
    await run({
      action: 'merge',
      method: 'ff',
      deletion: {
        effect: 'delete',
        repositoryKey: repositoryResourceKey(userId, identity),
        branch: 'feature',
        expectedHeadSha: revision.headSha,
      },
    })
  ).toMatchObject({ status: 'confirmed' });
  expect(review.state).toBe('merged');
  expect(branchExists).toBe(false);
  expect(writes.map(value => value.method)).toEqual(['PUT', 'DELETE']);
});
it('AC7 refuses a forged deletion choice before any merge effect', async () => {
  expect(
    await run({
      action: 'merge',
      method: 'ff',
      deletion: {
        effect: 'delete',
        repositoryKey: repositoryResourceKey(userId, identity),
        branch: 'someone-elses-branch',
        expectedHeadSha: revision.headSha,
      },
    })
  ).toMatchObject({
    status: 'partial',
    items: [
      { result: { status: 'rejected', code: 'forbidden' } },
      { result: { status: 'rejected', code: 'previous_effect_unconfirmed' } },
    ],
  });
  expect(review.state).toBe('opened');
  expect(branchExists).toBe(true);
  expect(writes).toEqual([]);
});
it.each([
  'reply',
  'resolveThread',
  'reopenThread',
  'addReaction',
  'removeReaction',
  'unapprove',
  'requestChanges',
] as const)('AC6 reconciles %s from its receipt after a read failure', async action => {
  const input: ReviewIntentInput =
    action === 'reply' || action === 'resolveThread' || action === 'reopenThread'
      ? {
          action,
          target: { provider: 'gitlab', kind: 'thread', id: 'thread', url: null },
          ...(action === 'reply' ? { body: 'Reply' } : {}),
        }
      : action === 'addReaction' || action === 'removeReaction'
        ? {
            action,
            target: { provider: 'gitlab', kind: 'comment', id: '8', url: null },
            reaction: action === 'addReaction' ? 'thumbsup' : '20',
          }
        : { action };
  notes[0].resolved = action === 'reopenThread';
  if (action === 'removeReaction') awards.push({ id: 20, name: 'thumbsup', user: actor });
  failReadAfterWrite = true;
  expect(await run(input)).toMatchObject({ status: 'unresolved', retry: 'reconcile' });
  failReadAfterWrite = false;
  expect(await run(input)).toMatchObject({ status: 'confirmed' });
  expect(writes).toHaveLength(1);
});
it.each(['side', 'line', 'range', 'provider'] as const)(
  'AC6 rejects inconsistent inline %s without dispatch',
  async change => {
    const selected = structuredClone(position);
    if (change === 'side') selected.side = 'old';
    if (change === 'line') selected.line = 9;
    if (change === 'range') selected.startLine = 4;
    if (change === 'provider') selected.native = { provider: 'github' };
    await expect(
      run({ action: 'inlineComment', body: 'Keep this draft', position: selected })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(writes).toEqual([]);
    expect(notes).toHaveLength(1);
  }
);
it.each([
  { action: 'approve', body: 'Do not silently discard this summary' },
  { action: 'comment', body: 'Do not silently drop this position', position },
  { action: 'addReaction', reaction: 'thumbsup' },
] satisfies ReviewIntentInput[])(
  'AC6 rejects incomplete or ignored input for $action',
  async input => {
    await expect(run(input)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(writes).toEqual([]);
  }
);
it('AC6 does not confirm a note from a different provider actor', async () => {
  providerActor = { ...actor, id: 10 };
  const input: ReviewIntentInput = { action: 'comment', body: 'Actor mismatch' };
  expect(await run(input)).toMatchObject({ status: 'unresolved' });
  expect(await run(input)).toMatchObject({ status: 'unresolved' });
  expect(notes.at(-1)?.author.id).toBe(10);
  expect(writes).toHaveLength(1);
});
it('AC6 preserves unfinished original positions when the head advances after partial publication', async () => {
  const input: ReviewIntentInput = {
    action: 'submitReview',
    comments: [
      { itemId: 'first', body: 'First', position },
      { itemId: 'second', body: 'Second', position },
    ],
    body: 'Summary',
    choice: 'approve',
  };
  let attempts = 0;
  beforeWrite = () => {
    if (++attempts === 2) failures.set(`POST ${root}/discussions`, 429);
  };
  expect(await run(input)).toMatchObject({ status: 'partial' });
  beforeWrite = undefined;
  failures.clear();
  review.sha = 'd'.repeat(40);
  review.diff_refs.head_sha = review.sha;
  expect(await run(input)).toMatchObject({
    status: 'partial',
    items: [
      { result: { status: 'confirmed' } },
      { result: { status: 'rejected', code: 'conflict' } },
      { result: { code: 'previous_effect_unconfirmed' } },
      { result: { code: 'previous_effect_unconfirmed' } },
    ],
  });
  expect(notes.map(item => item.body)).toEqual(['Original', 'First']);
  expect(writes).toHaveLength(1);
  expect(input.comments?.[1].position).toEqual(position);
});
it('AC7 rejects a changed merge SHA at the provider boundary', async () => {
  beforeWrite = () => {
    review.sha = 'd'.repeat(40);
    review.diff_refs.head_sha = review.sha;
  };
  expect(await run({ action: 'merge', method: 'ff' })).toMatchObject({
    status: 'rejected',
    code: 'conflict',
  });
  expect(review.state).toBe('opened');
  expect(branchExists).toBe(true);
  expect(writes).toEqual([]);
});
it.each(['default', 'protected', 'can_push'] as const)(
  'AC7 respects source branch %s restrictions before merge',
  async restriction => {
    branch[restriction] = restriction !== 'can_push';
    expect(
      await run({
        action: 'merge',
        method: 'ff',
        deletion: {
          effect: 'delete',
          repositoryKey: repositoryResourceKey(userId, identity),
          branch: 'feature',
          expectedHeadSha: revision.headSha,
        },
      })
    ).toMatchObject({ status: 'partial' });
    expect(review.state).toBe('opened');
    expect(branchExists).toBe(true);
    expect(writes).toEqual([]);
  }
);
it('AC7 confirms a lost deletion response without replaying merge or deletion', async () => {
  loseResponse = '/projects/123/repository/branches/feature';
  const input: ReviewIntentInput = {
    action: 'merge',
    method: 'ff',
    deletion: {
      effect: 'delete',
      repositoryKey: repositoryResourceKey(userId, identity),
      branch: 'feature',
      expectedHeadSha: revision.headSha,
    },
  };
  expect(await run(input)).toMatchObject({ status: 'partial' });
  expect(branchExists).toBe(false);
  expect(await run(input)).toMatchObject({ status: 'confirmed' });
  expect(writes.map(item => item.method)).toEqual(['PUT', 'DELETE']);
});
it('AC7 keeps an unrecorded rebase response unresolved instead of repeating the rebase', async () => {
  loseResponse = `${root}/rebase`;
  expect(await run({ action: 'updateBranch' })).toMatchObject({ status: 'unresolved' });
  expect(await run({ action: 'updateBranch' })).toMatchObject({ status: 'unresolved' });
  expect(review.rebase_in_progress).toBe(true);
  expect(writes).toHaveLength(1);
});
it('AC7 reports a provider-rejected rebase task without another write', async () => {
  expect(await run({ action: 'updateBranch' })).toMatchObject({ status: 'accepted' });
  review.rebase_in_progress = false;
  review.merge_error = 'Cannot rebase';
  expect(
    await runGitLabReviewOperation(auth, request({ action: 'updateBranch' }), true)
  ).toMatchObject({ status: 'rejected', code: 'rebase_failed', retry: 'never' });
  expect(writes).toHaveLength(1);
});
it.each(['old', 'new'] as const)(
  'AC6 preserves the %s side for single-line inline notes',
  async side => {
    const selected: ReviewPosition = {
      revision,
      oldPath: 'old.ts',
      newPath: 'new.ts',
      side,
      line: 3,
      native: {
        provider: 'gitlab',
        oldLine: side === 'old' ? 3 : null,
        newLine: side === 'new' ? 3 : null,
      },
    };
    expect(
      await run({ action: 'inlineComment', body: 'Single line', position: selected })
    ).toMatchObject({ status: 'confirmed' });
    expect(notes.at(-1)).toMatchObject({
      position: { old_line: side === 'old' ? 3 : null, new_line: side === 'new' ? 3 : null },
    });
  }
);
it.each(['reply', 'resolveThread'] as const)(
  'AC6 keeps %s usable for an image discussion with a deleted author',
  async action => {
    Object.assign(notes[0], { author: null, position: { position_type: 'image' } });
    expect(
      await run({
        action,
        target: { provider: 'gitlab', kind: 'thread', id: 'thread', url: null },
        ...(action === 'reply' ? { body: 'Image reply' } : {}),
      })
    ).toMatchObject({ status: 'confirmed' });
    if (action === 'reply') expect(notes.at(-1)?.body).toBe('Image reply');
    else expect(notes[0].resolved).toBe(true);
  }
);
it('AC6 refuses an inline selection absent from the current diff', async () => {
  jest.mocked(listGitLabFiles).mockResolvedValue({ items: [], nextCursor: null });
  expect(await run({ action: 'inlineComment', body: 'Keep this text', position })).toMatchObject({
    status: 'rejected',
    code: 'conflict',
  });
  expect(notes).toHaveLength(1);
  expect(writes).toEqual([]);
});
it.each([
  ['merge', 'default_off', false],
  ['rebase_merge', 'default_on', true],
  ['ff', 'always', true],
  ['ff', 'never', false],
] as const)('AC7 follows the %s method and %s squash policy', async (method, squash, expected) => {
  project.merge_method = method;
  project.squash_option = squash;
  overview.merge.methods = [{ id: method, label: method }];
  expect(await run({ action: 'merge', method })).toMatchObject({ status: 'confirmed' });
  expect(review.state).toBe('merged');
  expect(review.squash).toBe(expected);
});
it('AC7 applies the selected squash choice instead of the optional default', async () => {
  project.squash_option = 'default_off';
  expect(await run({ action: 'merge', method: 'ff', squash: true })).toMatchObject({
    status: 'confirmed',
  });
  expect(review.squash).toBe(true);
});
it('AC7 rejects changed live project policy before merge', async () => {
  project.merge_method = 'merge';
  expect(await run({ action: 'merge', method: 'ff' })).toMatchObject({
    status: 'rejected',
    code: 'conflict',
  });
  expect(review.state).toBe('opened');
  expect(writes).toEqual([]);
});
it('AC10 never guesses an auto-merge form when the authorized version is unknown', async () => {
  version = 'unknown';
  expect(await run({ action: 'enableAutoMerge', method: 'ff' })).toMatchObject({
    status: 'rejected',
  });
  expect(review.merge_when_pipeline_succeeds).toBe(false);
  expect(writes).toEqual([]);
});
it.each([
  [`${root}/notes`, { action: 'comment', body: 'Queued comment' }],
  [`${root}/discussions`, { action: 'inlineComment', body: 'Queued inline', position }],
  [
    `${root}/discussions/thread/notes`,
    {
      action: 'reply',
      body: 'Queued reply',
      target: { provider: 'gitlab', kind: 'thread', id: 'thread', url: null },
    },
  ],
  [
    `${root}/discussions/thread`,
    {
      action: 'resolveThread',
      target: { provider: 'gitlab', kind: 'thread', id: 'thread', url: null },
    },
  ],
  [
    `${root}/notes/8/award_emoji`,
    {
      action: 'addReaction',
      target: { provider: 'gitlab', kind: 'comment', id: '8', url: null },
      reaction: 'thumbsup',
    },
  ],
  [
    `${root}/notes/8/award_emoji/20`,
    {
      action: 'removeReaction',
      target: { provider: 'gitlab', kind: 'comment', id: '8', url: null },
      reaction: '20',
    },
  ],
  [`${root}/approve`, { action: 'approve' }],
  [`${root}/unapprove`, { action: 'unapprove' }],
  ['/GitLab/api/graphql', { action: 'requestChanges' }],
] satisfies [string, ReviewIntentInput][])(
  'AC6 reconciles an accepted response at %s without reporting early success',
  async (path, input) => {
    acceptedResponse = path;
    if (input.action === 'removeReaction') awards.push({ id: 20, name: 'thumbsup', user: actor });
    expect(await run(input)).toMatchObject({ status: 'accepted', retry: 'reconcile' });
    expect(await runGitLabReviewOperation(auth, request(input), true)).toMatchObject({
      status: 'confirmed',
    });
    expect(writes).toHaveLength(1);
  }
);
it('AC6 never treats an accepted draft publication as confirmed or retries its disappearance', async () => {
  acceptedResponse = `${root}/draft_notes/11/publish`;
  const input: ReviewIntentInput = {
    action: 'submitReview',
    comments: [{ itemId: '11', body: 'Draft', position }],
    draftReferences: [{ provider: 'gitlab', kind: 'comment', id: '11', url: null }],
  };
  expect(await run(input)).toMatchObject({
    status: 'partial',
    items: [{ result: { status: 'accepted' } }],
  });
  expect(await runGitLabReviewOperation(auth, request(input), true)).toMatchObject({
    status: 'partial',
    items: [{ result: { status: 'unresolved' } }],
  });
  expect(drafts.size).toBe(0);
  expect(writes).toHaveLength(1);
});
it('AC7 polls an accepted merge before reporting provider-confirmed completion', async () => {
  acceptedResponse = `${root}/merge`;
  const input: ReviewIntentInput = { action: 'merge', method: 'ff' };
  expect(await run(input)).toMatchObject({ status: 'accepted' });
  expect(review.state).toBe('opened');
  review.state = 'merged';
  expect(await runGitLabReviewOperation(auth, request(input), true)).toMatchObject({
    status: 'confirmed',
  });
  expect(writes).toHaveLength(1);
});
it('AC7 confirms accepted source deletion through branch absence without another delete', async () => {
  acceptedResponse = '/projects/123/repository/branches/feature';
  review.state = 'merged';
  const input: ReviewIntentInput = {
    action: 'deleteBranch',
    deletion: {
      effect: 'delete',
      repositoryKey: repositoryResourceKey(userId, identity),
      branch: 'feature',
      expectedHeadSha: revision.headSha,
    },
  };
  expect(await run(input)).toMatchObject({ status: 'accepted' });
  expect(await runGitLabReviewOperation(auth, request(input), true)).toMatchObject({
    status: 'confirmed',
  });
  expect(branchExists).toBe(false);
  expect(writes).toHaveLength(1);
});
it('AC10 preserves canonical host normalization in authorized provider URLs', async () => {
  review.web_url = identity.canonicalUrl.replace('gitlab.com', 'GITLAB.COM');
  expect(await run({ action: 'comment', body: 'Canonical host' })).toMatchObject({
    status: 'confirmed',
  });
  expect(notes.at(-1)?.body).toBe('Canonical host');
});
it('AC6 validates every batch key before publishing its first item', async () => {
  await expect(
    run({
      action: 'submitReview',
      comments: [
        { itemId: 'first', body: 'First', position },
        { itemId: 'x'.repeat(512), body: 'Second', position },
      ],
    })
  ).rejects.toMatchObject({ code: 'invalid_request' });
  expect(notes).toHaveLength(1);
  expect(writes).toEqual([]);
});
it.each([true, false])(
  'AC7 uses current project-actor merge permission %s when token scopes are unknown',
  async allowed => {
    auth.scopes = null;
    auth.credentialKind = 'gitlabProjectToken';
    auth.projectTokenId = '123';
    overview.authorization.capabilities.merge.permission = 'unknown';
    review.user.can_merge = allowed;
    expect(await run({ action: 'merge', method: 'ff' })).toMatchObject({
      status: allowed ? 'confirmed' : 'rejected',
    });
    expect(review.state).toBe(allowed ? 'merged' : 'opened');
    expect(writes).toHaveLength(allowed ? 1 : 0);
  }
);
it.each(['forbidden', 'not_connected', 'reconnect_required', 'request_too_large'] as const)(
  'AC6 treats pre-dispatch %s after preflight as a rejection, not an unknown write',
  async code => {
    let lookups = 0;
    jest.mocked(fetchGitLabCredential).mockImplementation(async () => {
      if (++lookups === 5) throw new GitLabInteractiveError(code);
      return { status: 'available', token: 'fixture-token', instanceUrl, glabIsOAuth2: false };
    });
    expect(await run({ action: 'comment', body: 'Preserve this work' })).toMatchObject({
      status: 'rejected',
      code,
      retry: 'never',
    });
    expect(notes).toHaveLength(1);
    expect(writes).toEqual([]);
  }
);
it.each(['confirmed', 'rejected'] as const)(
  'AC7 recovers an accepted rebase after unavailable status reads with outcome %s',
  async outcome => {
    const input: ReviewIntentInput = { action: 'updateBranch' };
    expect(await run(input)).toMatchObject({ status: 'accepted', retry: 'reconcile' });
    failReadAfterWrite = true;
    expect(await runGitLabReviewOperation(auth, request(input), true)).toMatchObject({
      status: 'unresolved',
      reason: 'reconciliation_unavailable',
      retry: 'reconcile',
    });
    records = new Map(JSON.parse(JSON.stringify([...records])));
    failReadAfterWrite = false;
    review.rebase_in_progress = false;
    review.merge_error = outcome === 'rejected' ? 'Cannot rebase' : null;
    review.sha = 'd'.repeat(40);
    review.diff_refs.head_sha = review.sha;
    const result = await run(input);
    expect(result).toMatchObject({ status: outcome, retry: 'never' });
    if (outcome === 'rejected') expect(result).toMatchObject({ code: 'rebase_failed' });
    expect(await runGitLabReviewOperation(auth, request(input), true)).toEqual(result);
    expect(writes).toHaveLength(1);
  }
);
it.each([
  { source: 'admitted', headSha: revision.headSha, status: 'confirmed' },
  { source: 'different', headSha: 'd'.repeat(40), status: 'unresolved' },
] as const)(
  'AC7 reconciles lost auto-merge completion for the $source source SHA',
  async ({ headSha, status }) => {
    loseResponse = `${root}/merge`;
    const input: ReviewIntentInput = { action: 'enableAutoMerge', method: 'ff', squash: true };
    expect(await run(input)).toMatchObject({ status: 'unresolved', retry: 'reconcile' });
    Object.assign(review, {
      state: 'merged',
      sha: headSha,
      merge_when_pipeline_succeeds: false,
      auto_merge_enabled: false,
      diff_refs: { ...review.diff_refs, head_sha: headSha, base_sha: 'e'.repeat(40) },
    });
    expect(await run(input)).toMatchObject({ status });
    expect(await runGitLabReviewOperation(auth, request(input), true)).toMatchObject({ status });
    expect(review.state).toBe('merged');
    expect(writes).toHaveLength(1);
  }
);
it.each([
  ['e'.repeat(40), false],
  ['e'.repeat(40), true],
  [null, true],
] as const)(
  'AC6 rejects unbound draft discussion %s with resolve_discussion=%s',
  async (discussion_id, resolve_discussion) => {
    draftDiscussion = { discussion_id, resolve_discussion };
    notes[0].resolved = !resolve_discussion;
    const originalNotes = structuredClone(notes);
    const input: ReviewIntentInput = {
      action: 'submitReview',
      comments: [{ itemId: '11', body: 'Draft', position }],
      draftReferences: [{ provider: 'gitlab', kind: 'comment', id: '11', url: null }],
      body: 'Summary',
      choice: 'approve',
    };
    const result = await run(input);
    expect(result).toMatchObject({
      status: 'partial',
      items: [
        {
          itemId: 'comment:11',
          effect: 'inlineComment',
          result: { status: 'rejected', code: 'conflict', retry: 'never' },
        },
        { result: { code: 'previous_effect_unconfirmed' } },
        { result: { code: 'previous_effect_unconfirmed' } },
      ],
    });
    expect(await run(input)).toEqual(result);
    expect(notes).toEqual(originalNotes);
    expect(drafts.has('11')).toBe(true);
    expect(overview.providerState).toMatchObject({ approvals: { actorIds: [] } });
    expect(writes).toEqual([]);
  }
);
