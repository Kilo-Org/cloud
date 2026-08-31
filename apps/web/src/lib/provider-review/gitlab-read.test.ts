jest.mock('@/lib/integrations/gitlab-service', () => ({ getGitLabIntegration: jest.fn() }));
jest.mock('@/lib/integrations/platforms/gitlab/credential-broker-client', () => ({
  fetchGitLabCredential: jest.fn(),
}));

import type { PlatformIntegration } from '@kilocode/db/schema';
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
import { getGitLabIntegration } from '@/lib/integrations/gitlab-service';
import { fetchGitLabCredential } from '@/lib/integrations/platforms/gitlab/credential-broker-client';
import { authorizeGitLabReview } from './gitlab-authorization';
import {
  getGitLabChecks,
  getGitLabFileContext,
  getGitLabReview,
  listGitLabDiffVersions,
  listGitLabDiscussions,
  listGitLabFiles,
  listGitLabInbox,
} from './gitlab-read';

const instanceUrl = 'https://gitlab.com/GitLab';
const integrationId = '11111111-1111-4111-8111-111111111111';
const userId = 'oauth/current-user';
const authorization: OwnerIntegrationAuthorization = {
  kind: 'ownerIntegration',
  owner: { type: 'user', id: userId },
  integrationId,
};
const repository: RepositoryIdentity = {
  provider: 'gitlab',
  instanceUrl,
  repositoryId: '123',
  fullName: 'Group/Sub/Repo',
  defaultBranch: 'trunk',
};
const canonicalUrl = `${instanceUrl}/Group/Sub/Repo/-/merge_requests/7`;
const identity: ReviewIdentity = {
  repository,
  authorization,
  number: '7',
  reviewId: '77',
  canonicalUrl,
};
const revision: ReviewRevision = {
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  startSha: 'c'.repeat(40),
  targetHeadSha: null,
};
const diff = {
  old_path: 'src/old.ts',
  new_path: 'src/new.ts',
  new_file: false,
  deleted_file: false,
  renamed_file: true,
  diff: '@@ -1 +1 @@\n-old\n+new',
};
const position = {
  position_type: 'text',
  old_path: diff.old_path,
  new_path: diff.new_path,
  head_sha: revision.headSha,
  base_sha: revision.baseSha,
  start_sha: revision.startSha,
  new_line: 6,
  old_line: null,
  line_range: {
    start: { line_code: 'code-4', type: 'new', new_line: 4 },
    end: { line_code: 'code-6', type: 'new', new_line: 6 },
  },
};
const note = {
  id: 8,
  body: 'Review text',
  created_at: '2026-08-29T12:00:00Z',
  author: { id: 9, username: 'provider-actor' },
  resolvable: true,
  resolved: true,
  position,
  current_user: { can_resolve: true },
};
const mergeRequest = {
  id: 77,
  iid: 7,
  project_id: 123,
  target_project_id: 123,
  source_project_id: 123,
  title: 'Nested review',
  description: 'Details',
  state: 'opened',
  draft: false,
  source_branch: 'feature',
  target_branch: 'trunk',
  sha: revision.headSha,
  diff_refs: {
    head_sha: revision.headSha,
    base_sha: revision.baseSha,
    start_sha: revision.startSha,
  },
  web_url: canonicalUrl,
  updated_at: '2026-08-29T12:00:00Z',
  author: note.author,
  user: { can_merge: true },
  detailed_merge_status: 'mergeable',
  blocking_discussions_resolved: true,
  merge_when_pipeline_succeeds: false,
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
const root = '/projects/123/merge_requests/7';
const filePath = '/projects/123/repository/files/src%2Fnew.ts';
const file = {
  file_path: diff.new_path,
  commit_id: revision.headSha,
  encoding: 'base64',
  content: Buffer.from('original\nsecond\nthird\n').toString('base64'),
  size: 22,
};
const contextInput = {
  file: { oldPath: diff.old_path, newPath: diff.new_path, revision },
  side: 'new' as const,
  startLine: 2,
  lineCount: 2,
};
let rows: Map<string, unknown>;
let failures: Map<string, number>;
let paged: Set<string>;
let review: typeof mergeRequest;
let integration: PlatformIntegration;
let afterDiff: (() => void) | undefined;

beforeEach(() => {
  jest.resetAllMocks();
  review = { ...mergeRequest, diff_refs: { ...mergeRequest.diff_refs }, user: { can_merge: true } };
  integration = {
    id: integrationId,
    platform: 'gitlab',
    owned_by_user_id: userId,
    owned_by_organization_id: null,
    integration_status: 'active',
    integration_type: 'oauth',
    suspended_at: null,
    auth_invalid_at: null,
    metadata: { gitlab_instance_url: instanceUrl },
    scopes: ['api'],
  } as PlatformIntegration;
  jest.mocked(getGitLabIntegration).mockImplementation(async () => integration);
  jest.mocked(fetchGitLabCredential).mockResolvedValue({
    status: 'available',
    token: 'test-credential',
    instanceUrl,
    glabIsOAuth2: true,
  });
  rows = new Map<string, unknown>([
    ['/user', { id: 9, username: 'provider-actor', name: 'Provider Actor' }],
    ['/metadata', { version: '17.11.0', enterprise: true }],
    ['/projects/123', { ...project }],
    [
      '/projects/124',
      {
        ...project,
        id: 124,
        path_with_namespace: 'Fork/Sub/Repo',
        web_url: `${instanceUrl}/Fork/Sub/Repo`,
      },
    ],
    ['/merge_requests', [review]],
    ['/projects/123/merge_requests', [review]],
    [root, review],
    [`${root}/diffs`, [diff]],
    [
      `${root}/versions`,
      [
        {
          id: 91,
          head_commit_sha: revision.headSha,
          base_commit_sha: revision.baseSha,
          start_commit_sha: revision.startSha,
          state: 'collected',
        },
      ],
    ],
    [
      `${root}/versions/91`,
      {
        id: 91,
        head_commit_sha: revision.headSha,
        base_commit_sha: revision.baseSha,
        start_commit_sha: revision.startSha,
        state: 'collected',
        real_size: '1',
        diffs: [diff],
      },
    ],
    [`${root}/pipelines`, []],
    [`/projects/123/repository/commits/${revision.headSha}/statuses`, []],
    [`${root}/commits`, [{ id: revision.headSha }]],
    [
      `${root}/approvals`,
      {
        approved: true,
        approvals_required: 1,
        approvals_left: 0,
        approved_by: [{ user: note.author }],
      },
    ],
    [`${root}/approval_state`, { rules: [{ eligible_approvers: [note.author], approved: true }] }],
    [`${root}/reviewers`, [{ user: note.author, state: 'requested_changes' }]],
    [`${root}/discussions`, [{ id: 'thread-1', notes: [note] }]],
    [
      `${root}/notes/8/award_emoji`,
      [
        { id: 41, name: 'thumbsup', user: { id: 10 } },
        { id: 42, name: 'thumbsup', user: note.author },
      ],
    ],
    [`${filePath}@${revision.headSha}`, { ...file }],
    [`/projects/124/repository/files/src%2Fnew.ts@${revision.headSha}`, { ...file }],
    [
      `/projects/123/repository/files/src%2Fold.ts@${revision.baseSha}`,
      {
        ...file,
        file_path: diff.old_path,
        commit_id: revision.baseSha,
        content: Buffer.from('base content\n').toString('base64'),
        size: 13,
      },
    ],
  ]);
  failures = new Map();
  paged = new Set();
  afterDiff = undefined;
  global.fetch = jest.fn(async (destination, init) => {
    if (init?.method !== 'GET') throw new Error('Read adapters cannot write');
    const url = new URL(String(destination));
    const path = url.pathname.replace('/GitLab/api/v4', '');
    const page = url.searchParams.get('page') ?? '1';
    const failure = failures.get(`${path}:${page}`) ?? failures.get(path);
    if (failure) return Response.json({ message: 'test-credential' }, { status: failure });
    const key = url.searchParams.has('ref') ? `${path}@${url.searchParams.get('ref')}` : path;
    let data = rows.get(`${key}:${page}`) ?? rows.get(key);
    if (data === undefined) return Response.json({}, { status: 404 });
    if (
      path === '/merge_requests' &&
      url.searchParams.get('reviewer_id') !== '9' &&
      url.searchParams.get('author_id') !== '9'
    )
      data = [];
    if (page === '2' && path === '/merge_requests')
      data = [
        {
          ...review,
          id: 78,
          iid: 8,
          title: 'Later review',
          web_url: canonicalUrl.replace('/7', '/8'),
        },
      ];
    const headers: Record<string, string> = {};
    if (paged.has(path) && page === '1') {
      url.searchParams.set('page', '2');
      headers.link = `<${url}>; rel="next"`;
      headers['x-next-page'] = '2';
    } else headers['x-next-page'] = '';
    const response = Response.json(data, { headers });
    if (path.endsWith('/diffs')) afterDiff?.();
    return response;
  });
});
const auth = () =>
  authorizeGitLabReview({
    userId,
    authorization: integration.owned_by_organization_id
      ? { ...authorization, owner: { type: 'org', id: integration.owned_by_organization_id } }
      : authorization,
    instanceUrl,
  });

it('AC4 uses the provider actor for reviewer and authored inbox filters', async () => {
  const selected = await auth();
  for (const filter of ['reviewer', 'author'] as const) {
    const inbox = await listGitLabInbox(selected, { filter });
    expect(inbox.scope).toMatchObject({
      kind: 'actor',
      actor: { id: '9', login: 'provider-actor' },
    });
    expect(inbox.items[0]).toMatchObject({ identity, title: 'Nested review' });
  }
});
it('AC4 never presents an organization actor as a Personal inbox', async () => {
  integration.owned_by_user_id = null;
  integration.owned_by_organization_id = '22222222-2222-4222-8222-222222222222';
  const selected = await auth();
  await expect(listGitLabInbox(selected)).rejects.toMatchObject({ code: 'invalid_request' });
  const inbox = await listGitLabInbox(selected, { repository });
  expect(inbox.scope).toEqual({ kind: 'repository', actor: selected.actor, repository });
  expect(inbox.items[0].identity.authorization).toEqual(selected.authorization);
});
it.each(['closed', 'merged'])(
  'AC4 keeps %s reviews readable with provider merge policy',
  async state => {
    review.state = state;
    const result = await getGitLabReview(await auth(), repository, '7');
    expect(result).toMatchObject({
      identity,
      state,
      revision,
      counts: { commits: 1, files: 1, additions: 1, deletions: 1 },
      merge: { methods: [{ id: 'ff', label: 'ff' }], squash: 'required' },
    });
    expect(result.authorization.capabilities.merge.restrictions).toContain(state);
  }
);
it('AC4 distinguishes no checks, no reviews, no files, and no discussions', async () => {
  for (const path of ['/merge_requests', `${root}/diffs`, `${root}/discussions`])
    rows.set(path, []);
  const selected = await auth();
  expect((await listGitLabInbox(selected)).items).toEqual([]);
  expect(await listGitLabFiles(selected, identity, revision)).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(await listGitLabDiscussions(selected, identity)).toEqual({ items: [], nextCursor: null });
  expect((await getGitLabReview(selected, repository, '7')).checks).toEqual({
    status: 'none',
    checks: [],
  });
});
it('AC4 includes current pipelines and commit checks without stale-head failures', async () => {
  rows.set(`${root}/pipelines`, [
    { id: 50, sha: 'd'.repeat(40), status: 'failed' },
    {
      id: 51,
      sha: revision.headSha,
      status: 'running',
      web_url: `${instanceUrl}/Group/Sub/Repo/-/pipelines/51`,
    },
  ]);
  rows.set(`/projects/123/repository/commits/${revision.headSha}/statuses`, [
    { id: 55, sha: revision.headSha, status: 'success', name: 'Build', allow_failure: false },
  ]);
  expect(await getGitLabChecks(await auth(), identity)).toMatchObject({
    status: 'reported',
    checks: [
      { id: 'pipeline:51', state: 'running' },
      { id: 'status:55', state: 'passed', required: true },
    ],
  });
});
it.each([
  [403, 'unavailable'],
  [503, 'temporarily_unavailable'],
] as const)('AC4 distinguishes check failure %s', async (status, expected) => {
  failures.set(`${root}/pipelines`, status);
  const selected = await auth();
  if (status === 403)
    expect(await getGitLabChecks(selected, identity)).toMatchObject({ status: expected });
  else await expect(getGitLabChecks(selected, identity)).rejects.toMatchObject({ code: expected });
});
it.each([
  ['17.10.0', 'merge_when_pipeline_succeeds'],
  ['17.11.0', 'auto_merge'],
])('AC4 derives auto-merge parameters from instance %s', async (version, method) => {
  rows.set('/metadata', { version, enterprise: false });
  review.merge_when_pipeline_succeeds = true;
  const result = await getGitLabReview(await auth(), repository, '7');
  expect(result.merge.autoMerge).toEqual({ method: 'ff' });
  expect(result.authorization.capabilities.enableAutoMerge.explanation).toBe(method);
  expect(result.providerState).toMatchObject({
    provider: 'gitlab',
    requestedChanges: {
      actorIds: ['9'],
      blocksMerge: false,
      blockingCapability: { license: 'unavailable' },
    },
  });
  expect(result.authorization.capabilities.requestChanges).toMatchObject({
    support: 'supported',
    version: 'available',
    license: 'available',
  });
});
it('AC4 does not claim an enterprise build proves licensed merge blocking', async () => {
  const result = await getGitLabReview(await auth(), repository, '7');
  expect(result.providerState).toMatchObject({
    requestedChanges: { blocksMerge: null, blockingCapability: { license: 'unknown' } },
  });
  review.detailed_merge_status = 'requested_changes';
  expect((await getGitLabReview(await auth(), repository, '7')).providerState).toMatchObject({
    requestedChanges: { blocksMerge: true, blockingCapability: { license: 'available' } },
  });
});
it('AC4 preserves readable content while denying missing write grants', async () => {
  integration.scopes = ['read_api'];
  const selected = await auth();
  const result = await getGitLabReview(selected, repository, '7');
  expect(result.authorization.capabilities.read.permission).toBe('allowed');
  for (const action of ['comment', 'approve', 'unapprove', 'merge'] as const)
    expect(result.authorization.capabilities[action]).toMatchObject({
      permission: 'forbidden',
      recovery: 'reconnect',
    });
  expect(
    (await listGitLabDiscussions(selected, identity)).items[0].capabilities.resolveThread
      ?.permission
  ).toBe('forbidden');
});
it('AC4 reports provider merge restrictions and denied merge permission separately', async () => {
  rows.set('/projects/123', {
    ...project,
    only_allow_merge_if_pipeline_succeeds: true,
    only_allow_merge_if_all_discussions_are_resolved: true,
  });
  review.blocking_discussions_resolved = false;
  review.user.can_merge = false;
  const capability = (await getGitLabReview(await auth(), repository, '7')).authorization
    .capabilities.merge;
  expect(capability.permission).toBe('forbidden');
  expect(capability.restrictions).toEqual(
    expect.arrayContaining(['discussions_not_resolved', 'pipeline_not_successful'])
  );
});

it('AC5 distinguishes unprepared diffs from an empty changed-file list', async () => {
  rows.set(root, { ...review, diff_refs: null });
  rows.set(`${root}/diffs`, []);
  await expect(
    listGitLabFiles(await auth(), identity, { ...revision, baseSha: null, startSha: null })
  ).rejects.toMatchObject({ code: 'temporarily_unavailable' });
});
it('AC5 preserves rename paths and base/head/start revisions', async () => {
  const files = await listGitLabFiles(await auth(), identity, revision);
  expect(files.items[0]).toMatchObject({
    oldPath: diff.old_path,
    newPath: diff.new_path,
    revision,
    status: 'renamed',
    patch: diff.diff,
    additions: 1,
    deletions: 1,
    canonicalUrl: `${instanceUrl}/Group/Sub/Repo/-/blob/${revision.headSha}/src/new.ts`,
  });
});
it.each(['new_file', 'deleted_file'])('AC5 preserves both native paths for %s', async flag => {
  rows.set(`${root}/diffs`, [{ ...diff, renamed_file: false, [flag]: true }]);
  expect((await listGitLabFiles(await auth(), identity, revision)).items[0]).toMatchObject({
    oldPath: diff.old_path,
    newPath: diff.new_path,
  });
});
it('AC5 reads immutable old-side context and fork new-side context', async () => {
  review.source_project_id = 124;
  const selected = await auth();
  const old = await getGitLabFileContext(selected, identity, {
    ...contextInput,
    side: 'old',
    startLine: 1,
  });
  expect(old).toMatchObject({
    content: 'available',
    path: diff.old_path,
    lines: ['base content'],
    revision,
    canonicalUrl: `${instanceUrl}/Group/Sub/Repo/-/blob/${revision.baseSha}/src/old.ts`,
  });
  const current = await getGitLabFileContext(selected, identity, contextInput);
  expect(current).toMatchObject({
    content: 'available',
    lines: ['second', 'third'],
    totalLines: 3,
    canonicalUrl: `${instanceUrl}/Fork/Sub/Repo/-/blob/${revision.headSha}/src/new.ts`,
  });
});
it('AC5 reads a historical version without relabeling it as the current head', async () => {
  const old = { ...revision, headSha: 'd'.repeat(40) };
  rows.set(`${root}/versions`, [
    {
      id: 91,
      head_commit_sha: old.headSha,
      base_commit_sha: old.baseSha,
      start_commit_sha: old.startSha,
    },
  ]);
  rows.set(`${root}/versions/91`, {
    id: 91,
    head_commit_sha: old.headSha,
    base_commit_sha: old.baseSha,
    start_commit_sha: old.startSha,
    state: 'collected',
    real_size: '1',
    diffs: [diff],
  });
  rows.set(`${filePath}@${old.headSha}`, { ...file, commit_id: old.headSha });
  const selected = await auth();
  expect((await listGitLabDiffVersions(selected, identity)).items).toEqual([
    { id: '91', revision: old },
  ]);
  expect((await listGitLabFiles(selected, identity, old, null, '91')).items[0].revision).toEqual(
    old
  );
  expect(
    await getGitLabFileContext(selected, identity, {
      ...contextInput,
      file: { ...contextInput.file, revision: old },
      versionId: '91',
    })
  ).toMatchObject({ revision: old, lines: ['second', 'third'] });
  await expect(listGitLabFiles(selected, identity, revision, null, '91')).rejects.toMatchObject({
    code: 'conflict',
  });
});
it('AC5 rejects a changed head instead of silently retargeting selected context', async () => {
  review.sha = 'd'.repeat(40);
  review.diff_refs.head_sha = review.sha;
  await expect(getGitLabFileContext(await auth(), identity, contextInput)).rejects.toMatchObject({
    code: 'conflict',
  });
});
it('AC5 rejects a head change during a diff page read', async () => {
  afterDiff = () => {
    review.sha = 'd'.repeat(40);
    review.diff_refs.head_sha = review.sha;
  };
  await expect(listGitLabFiles(await auth(), identity, revision)).rejects.toMatchObject({
    code: 'conflict',
  });
});
it.each([
  [Buffer.from([0, 1]), 2, 'binary'],
  [Buffer.from([255]), 1, 'binary'],
  [Buffer.from('partial'), 100, 'truncated'],
] as const)('AC5 explains unavailable text content %s', async (bytes, size, content) => {
  rows.set(`${filePath}@${revision.headSha}`, { ...file, content: bytes.toString('base64'), size });
  expect(await getGitLabFileContext(await auth(), identity, contextInput)).toMatchObject({
    content,
    lines: [],
    canonicalUrl: `${instanceUrl}/Group/Sub/Repo/-/blob/${revision.headSha}/src/new.ts`,
  });
});
it.each([
  [404, 'unavailable'],
  [503, 'temporarily_unavailable'],
] as const)('AC5 distinguishes unavailable and retryable context %s', async (status, expected) => {
  failures.set(filePath, status);
  const selected = await auth();
  if (status === 404)
    expect(await getGitLabFileContext(selected, identity, contextInput)).toMatchObject({
      content: expected,
    });
  else {
    await expect(getGitLabFileContext(selected, identity, contextInput)).rejects.toMatchObject({
      code: expected,
    });
    failures.clear();
    expect((await getGitLabFileContext(selected, identity, contextInput)).lines).toEqual([
      'second',
      'third',
    ]);
  }
});
it.each([{ commit_id: 'd'.repeat(40) }, { file_path: 'wrong.ts' }, { content: 'invalid base64!' }])(
  'AC5 rejects mismatched or corrupt file data: %j',
  async change => {
    rows.set(`${filePath}@${revision.headSha}`, { ...file, ...change });
    await expect(getGitLabFileContext(await auth(), identity, contextInput)).rejects.toMatchObject({
      code: 'content' in change ? 'invalid_response' : 'conflict',
    });
  }
);
it.each([{ too_large: true }, { collapsed: true }, { binary: true }])(
  'AC5 preserves provider content limits: %j',
  async change => {
    rows.set(`${root}/diffs`, [{ ...diff, ...change }]);
    expect((await listGitLabFiles(await auth(), identity, revision)).items[0]).toMatchObject({
      content: 'binary' in change ? 'binary' : 'truncated',
      patch: null,
    });
  }
);

it('AC6 separates resolution from outdatedness and preserves ranges, actors, and reactions', async () => {
  rows.set(`${root}/discussions`, [
    { id: 'current', notes: [note] },
    {
      id: 'old',
      notes: [{ ...note, resolved: false, position: { ...position, head_sha: 'd'.repeat(40) } }],
    },
  ]);
  const result = await listGitLabDiscussions(await auth(), identity);
  expect(result.items[0]).toMatchObject({
    resolved: true,
    outdated: false,
    position: {
      revision,
      oldPath: diff.old_path,
      newPath: diff.new_path,
      side: 'new',
      line: 6,
      startLine: 4,
      native: { provider: 'gitlab', lineRange: { start: { lineCode: 'code-4' } } },
    },
  });
  expect(result.items[0].comments.items[0]).toMatchObject({
    author: { id: '9' },
    reactions: [{ id: '42', content: 'thumbsup', count: 2, viewerHasReacted: true }],
  });
  expect(result.items[1]).toMatchObject({ resolved: false, outdated: true });
});
it('AC6 preserves conversation notes with a deleted author', async () => {
  rows.set(`${root}/discussions`, [
    { id: 'conversation', notes: [{ ...note, author: null, position: null, resolvable: false }] },
  ]);
  expect((await listGitLabDiscussions(await auth(), identity)).items[0]).toMatchObject({
    subjectType: 'conversation',
    position: null,
    file: null,
    outdated: null,
    resolved: null,
    comments: { items: [{ author: null, bodyMarkdown: 'Review text' }] },
  });
});
describe('Gitbeaker read request contracts', () => {
  it('AC4–AC5 preserves empty version and check results', async () => {
    rows.set(`${root}/versions`, []);
    const selected = await auth();
    expect(await listGitLabDiffVersions(selected, identity)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(await getGitLabChecks(selected, identity)).toEqual({ status: 'none', checks: [] });
  });

  it('AC5 keeps diff-version pages separate with the requested page size', async () => {
    const path = `${root}/versions`;
    const versions = Array.from({ length: 26 }, (_, index) => ({
      id: 91 + index,
      head_commit_sha: revision.headSha,
      base_commit_sha: revision.baseSha,
      start_commit_sha: revision.startSha,
    }));
    rows.set(path, versions.slice(0, 25));
    rows.set(`${path}:2`, versions.slice(25));
    paged.add(path);
    const selected = await auth();
    const first = await listGitLabDiffVersions(selected, identity);
    expect(first.items).toHaveLength(25);
    expect(first.items[0]).toEqual({ id: '91', revision });
    expect(first.items[24]).toEqual({ id: '115', revision });
    expect(await listGitLabDiffVersions(selected, identity, first.nextCursor)).toEqual({
      items: [{ id: '116', revision }],
      nextCursor: null,
    });
    const queries = jest
      .mocked(global.fetch)
      .mock.calls.map(([destination]) => new URL(String(destination)))
      .filter(url => url.pathname.endsWith(path))
      .map(url => Object.fromEntries(url.searchParams));
    expect(queries).toEqual([
      { page: '1', per_page: '25' },
      { page: '2', per_page: '25' },
    ]);
  });

  it('AC4 reads every status page without changing the latest-check query', async () => {
    const path = `/projects/123/repository/commits/${revision.headSha}/statuses`;
    const status = {
      id: 55,
      sha: revision.headSha,
      status: 'success',
      name: 'Build',
      allow_failure: false,
    };
    rows.set(
      path,
      Array.from({ length: 100 }, (_, index) => ({ ...status, id: 1000 + index }))
    );
    rows.set(`${path}:2`, [
      { ...status, id: 2000, status: 'failed', name: 'Optional', allow_failure: true },
      { ...status, id: 2001, sha: 'd'.repeat(40), status: 'failed' },
    ]);
    paged.add(path);
    const result = await getGitLabChecks(await auth(), identity);
    expect(result).toMatchObject({
      status: 'reported',
      checks: expect.arrayContaining([
        { id: 'status:1000', state: 'passed', name: 'Build', required: true, detailsUrl: null },
        { id: 'status:1099', state: 'passed', name: 'Build', required: true, detailsUrl: null },
        { id: 'status:2000', state: 'failed', name: 'Optional', required: false, detailsUrl: null },
      ]),
    });
    if (result.status === 'reported') expect(result.checks).toHaveLength(101);
    const queries = jest
      .mocked(global.fetch)
      .mock.calls.map(([destination]) => new URL(String(destination)))
      .filter(url => url.pathname.endsWith(path))
      .map(url => Object.fromEntries(url.searchParams));
    expect(queries).toEqual([{ per_page: '100' }, { per_page: '100', page: '2' }]);
  });

  it.each([
    [401, 'reconnect_required'],
    [403, 'unavailable'],
    [503, 'temporarily_unavailable'],
  ] as const)('AC4 never reports partial checks after a later-page %s', async (status, code) => {
    const path = `/projects/123/repository/commits/${revision.headSha}/statuses`;
    rows.set(path, [{ id: 55, sha: revision.headSha, status: 'success', name: 'Build' }]);
    rows.set(`${path}:2`, [{ id: 56, sha: revision.headSha, status: 'failed', name: 'Later' }]);
    paged.add(path);
    failures.set(`${path}:2`, status);
    const selected = await auth();
    const result = getGitLabChecks(selected, identity);
    if (status === 403)
      await expect(result).resolves.toEqual({
        status: 'unavailable',
        explanation: 'forbidden_or_unavailable',
      });
    else
      await expect(result).rejects.toMatchObject({
        code,
        message: `GitLab interactive request failed: ${code} (${status})`,
      });
    if (status === 503) {
      failures.clear();
      expect(await getGitLabChecks(selected, identity)).toMatchObject({
        status: 'reported',
        checks: [
          { id: 'status:55', state: 'passed' },
          { id: 'status:56', state: 'failed' },
        ],
      });
    }
  });
});

it.each(['inbox', 'files', 'versions', 'discussions'] as const)(
  'AC4–AC6 retains the loaded %s page across a later-page failure and retry',
  async surface => {
    const path =
      surface === 'inbox'
        ? '/merge_requests'
        : `${root}/${surface === 'files' ? 'diffs' : surface}`;
    paged.add(path);
    const selected = await auth();
    const read = (cursor?: ReviewCursor | null) =>
      surface === 'inbox'
        ? listGitLabInbox(selected, { cursor })
        : surface === 'files'
          ? listGitLabFiles(selected, identity, revision, cursor)
          : surface === 'versions'
            ? listGitLabDiffVersions(selected, identity, cursor)
            : listGitLabDiscussions(selected, identity, cursor);
    const first = await read();
    const retained = JSON.stringify(first);
    expect(first.nextCursor).not.toBeNull();
    failures.set(`${path}:2`, 503);
    await expect(read(first.nextCursor)).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(JSON.stringify(first)).toBe(retained);
    failures.clear();
    const second = await read(first.nextCursor);
    expect(second.nextCursor).toBeNull();
    expect(second.items).toHaveLength(1);
    if (surface === 'inbox') expect(second.items[0]).toMatchObject({ title: 'Later review' });
  }
);
it('AC4–AC6 rejects cursors from another actor, revision, or surface', async () => {
  paged.add(`${root}/diffs`);
  const selected = await auth();
  const first = await listGitLabFiles(selected, identity, revision);
  await expect(
    listGitLabFiles(
      { ...selected, actor: { ...selected.actor, id: '10' } },
      identity,
      revision,
      first.nextCursor
    )
  ).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(
    listGitLabFiles(selected, identity, { ...revision, headSha: 'd'.repeat(40) }, first.nextCursor)
  ).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(listGitLabDiscussions(selected, identity, first.nextCursor)).rejects.toMatchObject({
    code: 'invalid_request',
  });
});
it('AC4–AC6 rejects a foreign owner and a wrong provider review ID', async () => {
  const selected = await auth();
  await expect(
    listGitLabDiscussions(selected, {
      ...identity,
      authorization: { ...authorization, integrationId: '33333333-3333-4333-8333-333333333333' },
    })
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    listGitLabFiles(selected, { ...identity, reviewId: 'other-review' }, revision)
  ).rejects.toMatchObject({ code: 'not_found' });
});
it('AC4–AC6 rejects malformed provider records rather than returning empty success', async () => {
  rows.set(`${root}/discussions`, [{ id: 'broken', notes: [] }]);
  await expect(listGitLabDiscussions(await auth(), identity)).rejects.toMatchObject({
    code: 'invalid_response',
  });
});
it('AC4 rejects checks requested for a stale displayed revision', async () => {
  await expect(
    getGitLabChecks(await auth(), identity, { ...revision, headSha: 'd'.repeat(40) })
  ).rejects.toMatchObject({ code: 'conflict' });
});
it('AC5 keeps an inaccessible fork readable without borrowing source access', async () => {
  review.source_project_id = 124;
  failures.set('/projects/124', 403);
  const selected = await auth();
  expect(await getGitLabReview(selected, repository, '7')).toMatchObject({
    identity,
    source: { repository: null, branch: 'feature' },
  });
  expect(await getGitLabFileContext(selected, identity, contextInput)).toMatchObject({
    content: 'unavailable',
    lines: [],
    canonicalUrl,
  });
});
it('AC4 preserves unknown version and license states without claiming provider limitations', async () => {
  for (const path of ['/metadata', `${root}/approvals`, `${root}/reviewers`])
    failures.set(path, 404);
  const result = await getGitLabReview(await auth(), repository, '7');
  expect(result.authorization.capabilities.enableAutoMerge).toMatchObject({
    support: 'supported',
    version: 'unknown',
    recovery: 'openProvider',
  });
  expect(result.authorization.capabilities.requestChanges).toMatchObject({
    support: 'supported',
    version: 'unknown',
    recovery: 'openProvider',
  });
  expect(result.providerState).toMatchObject({
    approvals: { approved: null, required: null },
    requestedChanges: { blocksMerge: null },
  });
});
it('AC4 permits scheduling and cancellation while a required pipeline runs', async () => {
  rows.set('/projects/123', { ...project, only_allow_merge_if_pipeline_succeeds: true });
  rows.set(`${root}/pipelines`, [{ id: 51, sha: revision.headSha, status: 'running' }]);
  review.detailed_merge_status = 'ci_still_running';
  review.merge_when_pipeline_succeeds = true;
  const capabilities = (await getGitLabReview(await auth(), repository, '7')).authorization
    .capabilities;
  expect(capabilities.merge.restrictions).toContain('ci_still_running');
  expect(capabilities.enableAutoMerge.restrictions).toEqual([]);
  expect(capabilities.disableAutoMerge.restrictions).toEqual([]);
});
it('AC5 bounds decoded context after JSON escaping expands the content', async () => {
  const bytes = Buffer.from('\u0001'.repeat(2 * 1024 * 1024));
  rows.set(`${filePath}@${revision.headSha}`, {
    ...file,
    content: bytes.toString('base64'),
    size: bytes.length,
  });
  expect(
    await getGitLabFileContext(await auth(), identity, { ...contextInput, startLine: 1 })
  ).toMatchObject({ content: 'truncated', lines: [] });
});
it('AC5 exposes a bounded response as truncated context with an exact file URL', async () => {
  const fetch = global.fetch;
  global.fetch = jest.fn(async (destination, init) =>
    String(destination).includes('/repository/files/')
      ? Response.json({}, { headers: { 'content-length': String(10 * 1024 * 1024 + 1) } })
      : fetch(destination, init)
  );
  expect(await getGitLabFileContext(await auth(), identity, contextInput)).toMatchObject({
    content: 'truncated',
    lines: [],
    canonicalUrl: `${instanceUrl}/Group/Sub/Repo/-/blob/${revision.headSha}/src/new.ts`,
  });
});
it('AC5 returns an empty text file without confusing it with unavailable content', async () => {
  rows.set(`${filePath}@${revision.headSha}`, { ...file, content: '', size: 0 });
  expect(
    await getGitLabFileContext(await auth(), identity, { ...contextInput, startLine: 1 })
  ).toMatchObject({ content: 'available', totalLines: 0, lines: [] });
});
it.each([0, 501])('AC5 rejects an invalid context line count %s', async lineCount => {
  await expect(
    getGitLabFileContext(await auth(), identity, { ...contextInput, lineCount })
  ).rejects.toMatchObject({ code: 'invalid_request' });
});
it('AC5 rejects a provider path that escapes the selected repository', async () => {
  rows.set(`${root}/diffs`, [{ ...diff, new_path: '../Other/private.ts' }]);
  await expect(listGitLabFiles(await auth(), identity, revision)).rejects.toMatchObject({
    code: 'invalid_response',
  });
});
it.each(['overflow', 'collected'])('AC5 exposes a limited version with %s state', async state => {
  rows.set(`${root}/versions/91`, {
    id: 91,
    head_commit_sha: revision.headSha,
    base_commit_sha: revision.baseSha,
    start_commit_sha: revision.startSha,
    state,
    real_size: '1000+',
    diffs: [],
  });
  await expect(listGitLabFiles(await auth(), identity, revision, null, '91')).rejects.toMatchObject(
    { code: 'response_too_large' }
  );
});
it('AC6 reads a single old-side position with a null line range', async () => {
  rows.set(`${root}/discussions`, [
    {
      id: 'old-line',
      notes: [
        { ...note, position: { ...position, line_range: null, old_line: 5, new_line: null } },
      ],
    },
  ]);
  expect((await listGitLabDiscussions(await auth(), identity)).items[0].position).toMatchObject({
    side: 'old',
    line: 5,
    native: { oldLine: 5, newLine: null },
  });
});
it('AC6 uses the old end side of a range even when both line numbers exist', async () => {
  rows.set(`${root}/discussions`, [
    {
      id: 'old-range',
      notes: [
        {
          ...note,
          position: {
            ...position,
            old_line: 5,
            new_line: 6,
            line_range: {
              start: { type: 'old', line_code: 'old-3', old_line: 3 },
              end: { type: 'old', line_code: 'old-5', old_line: 5 },
            },
          },
        },
      ],
    },
  ]);
  expect((await listGitLabDiscussions(await auth(), identity)).items[0].position).toMatchObject({
    side: 'old',
    line: 5,
    startSide: 'old',
    startLine: 3,
    native: { oldLine: 5, newLine: 6 },
  });
});
it('AC6 bounds combined reaction results across separate provider responses', async () => {
  rows.set(`${root}/discussions`, [{ id: 'large-reactions', notes: [note, { ...note, id: 9 }] }]);
  const awards = [{ id: 42, name: 'x'.repeat(6 * 1024 * 1024), user: note.author }];
  rows.set(`${root}/notes/8/award_emoji`, awards);
  rows.set(`${root}/notes/9/award_emoji`, awards);
  await expect(listGitLabDiscussions(await auth(), identity)).rejects.toMatchObject({
    code: 'response_too_large',
  });
});
it.each(['pipelines', 'statuses'])(
  'AC4 rejects an incomplete %s aggregate at the SDK page ceiling',
  async surface => {
    const fetch = global.fetch;
    global.fetch = jest.fn(async (destination, init) => {
      const url = new URL(String(destination));
      if (!url.pathname.endsWith(`/${surface}`)) return fetch(destination, init);
      const current = Number(url.searchParams.get('page') ?? 1);
      url.searchParams.set('page', String(current + 1));
      return Response.json(
        [{ id: current, sha: revision.headSha, status: 'running', name: 'Build' }],
        {
          headers: { link: `<${url}>; rel="next"`, 'x-next-page': String(current + 1) },
        }
      );
    });
    await expect(getGitLabChecks(await auth(), identity)).rejects.toMatchObject({
      code: 'pagination_limit',
    });
    const requests = jest
      .mocked(global.fetch)
      .mock.calls.filter(([destination]) =>
        new URL(String(destination)).pathname.endsWith(`/${surface}`)
      );
    expect(requests).toHaveLength(100);
  }
);
it('AC6 bounds discussion expansion instead of dropping notes', async () => {
  rows.set(`${root}/discussions`, [
    { id: 'large', notes: Array.from({ length: 101 }, () => note) },
  ]);
  await expect(listGitLabDiscussions(await auth(), identity)).rejects.toMatchObject({
    code: 'response_too_large',
  });
});
it('AC6 derives approval eligibility and withdrawal state from documented responses', async () => {
  const selected = await auth();
  const first = await getGitLabReview(selected, repository, '7');
  expect(first.authorization.capabilities.approve.permission).toBe('allowed');
  expect(first.authorization.capabilities.unapprove).toMatchObject({
    permission: 'allowed',
    restrictions: [],
  });
  rows.set(`${root}/approvals`, { approved: true, approved_by: [{ user: { id: 10 } }] });
  const other = await getGitLabReview(selected, repository, '7');
  expect(other.providerState).toMatchObject({ approvals: { actorIds: ['10'] } });
  expect(other.authorization.capabilities.unapprove).toMatchObject({
    permission: 'allowed',
    restrictions: ['not_approved'],
  });
});
it.each([
  [40, 10, 'allowed'],
  [20, 9, 'allowed'],
  [20, 10, 'forbidden'],
] as const)(
  'AC6 derives resolution permission from role %s and MR author %s',
  async (accessLevel, authorId, permission) => {
    rows.set('/projects/123', {
      ...project,
      permissions: { project_access: { access_level: accessLevel } },
    });
    rows.set(root, { ...review, author: { id: authorId } });
    rows.set(`${root}/discussions`, [
      { id: 'native', notes: [{ ...note, current_user: undefined }] },
    ]);
    expect(
      (await listGitLabDiscussions(await auth(), identity)).items[0].capabilities.resolveThread
        ?.permission
    ).toBe(permission);
  }
);

describe('c1-r3 provider read regressions', () => {
  it.each(['allowed failure', 'superseded pipeline'] as const)(
    'keeps a successful current pipeline mergeable with an %s',
    async failure => {
      const current = { id: 52, sha: revision.headSha, status: 'success' };
      rows.set(root, { ...review, head_pipeline: current });
      rows.set('/projects/123', { ...project, only_allow_merge_if_pipeline_succeeds: true });
      rows.set(`${root}/pipelines`, [
        ...(failure === 'superseded pipeline'
          ? [{ id: 51, sha: revision.headSha, status: 'failed' }]
          : []),
        current,
      ]);
      if (failure === 'allowed failure')
        rows.set(`/projects/123/repository/commits/${revision.headSha}/statuses`, [
          {
            id: 55,
            sha: revision.headSha,
            status: 'failed',
            name: 'Optional',
            allow_failure: true,
          },
        ]);
      const result = await getGitLabReview(await auth(), repository, '7');
      expect(reviewActionAvailability(result.authorization.capabilities.merge)).toBe('available');
      expect(result.checks).toMatchObject({
        status: 'reported',
        checks: expect.arrayContaining([
          {
            id: failure === 'allowed failure' ? 'status:55' : 'pipeline:51',
            name: failure === 'allowed failure' ? 'Optional' : '#51',
            state: 'failed',
            required: false,
            detailsUrl: null,
          },
        ]),
      });
    }
  );
  it.each([
    ['failed', false, 'restricted'],
    ['skipped', false, 'restricted'],
    ['skipped', true, 'available'],
  ] as const)(
    'applies current pipeline %s with skipped policy %s',
    async (status, allowSkipped, expected) => {
      const current = { id: 52, sha: 'd'.repeat(40), status };
      rows.set(root, { ...review, head_pipeline: current });
      rows.set('/projects/123', {
        ...project,
        only_allow_merge_if_pipeline_succeeds: true,
        allow_merge_on_skipped_pipeline: allowSkipped,
      });
      rows.set(`${root}/pipelines`, [
        { id: 51, sha: revision.headSha, status: 'success' },
        current,
      ]);
      const result = await getGitLabReview(await auth(), repository, '7');
      expect(reviewActionAvailability(result.authorization.capabilities.merge)).toBe(expected);
    }
  );

  it.each([
    ['files', 'overflow', '1000+'],
    ['overview', 'overflow', '1000+'],
    ['context', 'overflow', '1000+'],
    ['files', 'collected', '2'],
    ['overview', 'collected', '2'],
    ['context', 'collected', '2'],
    ['files', 'collected', '1000+'],
    ['overview', 'collected', '1000+'],
    ['context', 'collected', '1000+'],
  ] as const)(
    'rejects limited %s with %s metadata and size %s',
    async (surface, state, realSize) => {
      rows.set(`${root}/versions`, [
        {
          id: 91,
          head_commit_sha: revision.headSha,
          base_commit_sha: revision.baseSha,
          start_commit_sha: revision.startSha,
          state,
          real_size: realSize,
        },
      ]);
      const selected = await auth();
      const result =
        surface === 'files'
          ? listGitLabFiles(selected, identity, revision)
          : surface === 'overview'
            ? getGitLabReview(selected, repository, '7')
            : getGitLabFileContext(selected, identity, contextInput);
      await expect(result).rejects.toMatchObject({ code: 'response_too_large' });
    }
  );
  it('keeps complete current reads available beside an older overflow version', async () => {
    rows.set(`${root}/versions`, [
      {
        id: 91,
        head_commit_sha: revision.headSha,
        base_commit_sha: revision.baseSha,
        start_commit_sha: revision.startSha,
        state: 'collected',
        real_size: '1',
      },
      {
        id: 90,
        head_commit_sha: 'd'.repeat(40),
        base_commit_sha: revision.baseSha,
        start_commit_sha: revision.startSha,
        state: 'overflow',
        real_size: '1000+',
      },
    ]);
    const selected = await auth();
    expect((await listGitLabFiles(selected, identity, revision)).items).toHaveLength(1);
    expect((await getGitLabReview(selected, repository, '7')).counts.files).toBe(1);
    expect(await getGitLabFileContext(selected, identity, contextInput)).toMatchObject({
      content: 'available',
      lines: ['second', 'third'],
    });
    expect((await listGitLabDiffVersions(selected, identity)).items).toHaveLength(2);
  });

  it('returns completed empty current files and overview counts', async () => {
    rows.set(`${root}/versions`, [
      {
        id: 91,
        head_commit_sha: revision.headSha,
        base_commit_sha: revision.baseSha,
        start_commit_sha: revision.startSha,
        state: 'empty',
        real_size: '0',
      },
    ]);
    rows.set(`${root}/diffs`, []);
    const selected = await auth();
    expect(await listGitLabFiles(selected, identity, revision)).toMatchObject({
      items: [],
      nextCursor: null,
    });
    expect((await getGitLabReview(selected, repository, '7')).counts.files).toBe(0);
  });

  it.each(['timeout', 'unknown', 'empty', undefined])(
    'keeps current diff state %s unavailable',
    async state => {
      rows.set(`${root}/versions`, [
        {
          id: 91,
          head_commit_sha: revision.headSha,
          base_commit_sha: revision.baseSha,
          start_commit_sha: revision.startSha,
          state,
        },
      ]);
      await expect(listGitLabFiles(await auth(), identity, revision)).rejects.toMatchObject({
        code: 'temporarily_unavailable',
      });
    }
  );
  it('does not use another revision to prove current diff completeness', async () => {
    rows.set(`${root}/versions`, [
      {
        id: 91,
        head_commit_sha: 'd'.repeat(40),
        base_commit_sha: revision.baseSha,
        start_commit_sha: revision.startSha,
        state: 'collected',
      },
    ]);
    await expect(listGitLabFiles(await auth(), identity, revision)).rejects.toMatchObject({
      code: 'temporarily_unavailable',
    });
  });
  it('keeps historical files and context readable when the current diff overflows', async () => {
    const historical = { ...revision, headSha: 'd'.repeat(40) };
    rows.set(`${root}/versions`, [
      {
        id: 92,
        head_commit_sha: revision.headSha,
        base_commit_sha: revision.baseSha,
        start_commit_sha: revision.startSha,
        state: 'overflow',
      },
    ]);
    rows.set(`${root}/versions/91`, {
      id: 91,
      head_commit_sha: historical.headSha,
      base_commit_sha: historical.baseSha,
      start_commit_sha: historical.startSha,
      state: 'collected',
      diffs: [diff],
    });
    rows.set(`${filePath}@${historical.headSha}`, { ...file, commit_id: historical.headSha });
    const selected = await auth();
    expect(
      (await listGitLabFiles(selected, identity, historical, null, '91')).items[0]
    ).toMatchObject({
      revision: historical,
      patch: diff.diff,
    });
    expect(
      await getGitLabFileContext(selected, identity, {
        ...contextInput,
        file: { ...contextInput.file, revision: historical },
        versionId: '91',
      })
    ).toMatchObject({ revision: historical, content: 'available', lines: ['second', 'third'] });
  });

  it.each([
    ['assigned developer', 30, 10, false, true, 'allowed'],
    ['assigned author', 10, 9, false, true, 'allowed'],
    ['assigned assignee', 10, 10, true, true, 'allowed'],
    ['unproved project permission', undefined, 10, false, true, 'unknown'],
    ['reader role', 10, 10, false, true, 'unknown'],
    ['unassigned actor', 40, 9, false, false, 'forbidden'],
  ] as const)(
    'derives request-changes permission for an %s',
    async (_label, accessLevel, authorId, assignee, assigned, permission) => {
      rows.set('/projects/123', {
        ...project,
        permissions:
          accessLevel === undefined
            ? undefined
            : {
                project_access: { access_level: accessLevel },
                group_access: null,
              },
      });
      rows.set(root, {
        ...review,
        author: { id: authorId },
        assignees: assignee ? [note.author] : [],
      });
      rows.set(`${root}/reviewers`, [
        ...(assigned ? [{ user: note.author, state: 'unreviewed' }] : []),
        { user: { id: 10 }, state: 'requested_changes' },
      ]);
      const result = await getGitLabReview(await auth(), repository, '7');
      const capability = result.authorization.capabilities.requestChanges;
      expect(capability.permission).toBe(permission);
      expect(reviewActionAvailability(capability)).toBe(
        permission === 'allowed' ? 'available' : permission
      );
      expect(result.providerState).toMatchObject({ requestedChanges: { actorIds: ['10'] } });
    }
  );
  it('keeps an unavailable reviewer assignment unknown', async () => {
    failures.set(`${root}/reviewers`, 403);
    const capability = (await getGitLabReview(await auth(), repository, '7')).authorization
      .capabilities.requestChanges;
    expect(capability.permission).toBe('unknown');
    expect(reviewActionAvailability(capability)).toBe('unknown');
  });
  it('does not infer request-changes support from an assigned actor alone', async () => {
    rows.set(`${root}/reviewers`, [{ user: note.author, state: 'unreviewed' }]);
    const capability = (await getGitLabReview(await auth(), repository, '7')).authorization
      .capabilities.requestChanges;
    expect(capability).toMatchObject({ permission: 'allowed', version: 'unknown' });
    expect(reviewActionAvailability(capability)).toBe('unknown');
  });
  it.each([
    [['read_api'], true, 'forbidden', 'reconnect'],
    [null, true, 'unknown', 'openProvider'],
    [null, false, 'forbidden', 'openProvider'],
  ] as const)(
    'retains request-changes grant and assignment limits: %j, %s',
    async (scopes, assigned, permission, recovery) => {
      integration.scopes = scopes === null ? null : [...scopes];
      rows.set(`${root}/reviewers`, [
        ...(assigned ? [{ user: note.author, state: 'unreviewed' }] : []),
        { user: { id: 10 }, state: 'requested_changes' },
      ]);
      const capability = (await getGitLabReview(await auth(), repository, '7')).authorization
        .capabilities.requestChanges;
      expect(capability).toMatchObject({ permission, recovery });
      expect(reviewActionAvailability(capability)).toBe(permission);
    }
  );

  it.each([
    ['open reply', true, true, false, false],
    ['fully resolved', true, true, true, true],
    ['unknown reply resolution', true, true, undefined, null],
    ['known open reply after unknown first note', undefined, true, false, false],
    ['non-resolvable reply', true, false, false, true],
    ['unknown reply resolvability', true, undefined, false, null],
  ] as const)(
    'aggregates %s independently from outdatedness',
    async (_label, firstResolved, replyResolvable, replyResolved, resolved) => {
      const notes = [
        { ...note, resolved: firstResolved },
        { ...note, id: 9, resolvable: replyResolvable, resolved: replyResolved, position: null },
      ];
      rows.set(`${root}/notes/9/award_emoji`, []);
      rows.set(`${root}/discussions`, [
        { id: 'current', notes },
        {
          id: 'outdated',
          notes: [{ ...notes[0], position: { ...position, head_sha: 'd'.repeat(40) } }, notes[1]],
        },
      ]);
      const result = await listGitLabDiscussions(await auth(), identity);
      expect(
        result.items.map(thread => ({ resolved: thread.resolved, outdated: thread.outdated }))
      ).toEqual([
        { resolved, outdated: false },
        { resolved, outdated: true },
      ]);
    }
  );
});

describe('c1 post-takeover diff regressions', () => {
  // https://docs.gitlab.com/api/merge_requests/#retrieve-a-merge-request-diff-version
  const version = {
    id: 91,
    head_commit_sha: revision.headSha,
    base_commit_sha: revision.baseSha,
    start_commit_sha: revision.startSha,
    state: 'collected',
    real_size: '1',
  };

  describe.each([
    { selection: 'current', versionId: undefined },
    { selection: 'explicit', versionId: '91' },
  ])('$selection version completion', ({ versionId }) => {
    it.each([
      { state: 'unknown', real_size: '0' },
      { state: undefined, real_size: '0' },
      { state: 'timeout', real_size: '0' },
      { state: 'empty', real_size: undefined },
      { state: 'empty', real_size: '1' },
    ])('keeps unfinished metadata retryable through both file reads: %j', async metadata => {
      rows.set(`${root}/versions`, [{ ...version, ...metadata }]);
      rows.set(`${root}/versions/91`, { ...version, ...metadata, diffs: [] });
      rows.set(`${root}/diffs`, []);
      const selected = await auth();
      expect(
        await Promise.allSettled([
          listGitLabFiles(selected, identity, revision, null, versionId),
          getGitLabFileContext(selected, identity, { ...contextInput, versionId }),
        ])
      ).toMatchObject([
        { status: 'rejected', reason: { code: 'temporarily_unavailable' } },
        { status: 'rejected', reason: { code: 'temporarily_unavailable' } },
      ]);

      rows.set(`${root}/versions`, [version]);
      rows.set(`${root}/versions/91`, { ...version, diffs: [diff] });
      rows.set(`${root}/diffs`, [diff]);
      expect(
        (await listGitLabFiles(selected, identity, revision, null, versionId)).items
      ).toMatchObject([{ revision, patch: diff.diff, additions: 1, deletions: 1 }]);
      expect(
        await getGitLabFileContext(selected, identity, { ...contextInput, versionId })
      ).toMatchObject({ revision, content: 'available', lines: ['second', 'third'] });
    });

    it.each(['collected', 'without_files'])('reads completed %s metadata', async state => {
      rows.set(`${root}/versions`, [{ ...version, state }]);
      rows.set(`${root}/versions/91`, { ...version, state, diffs: [diff] });
      const selected = await auth();
      expect(
        (await listGitLabFiles(selected, identity, revision, null, versionId)).items
      ).toMatchObject([{ revision, patch: diff.diff, additions: 1, deletions: 1 }]);
      expect(
        await getGitLabFileContext(selected, identity, { ...contextInput, versionId })
      ).toMatchObject({
        revision,
        content: 'available',
        lines: ['second', 'third'],
        canonicalUrl: `${instanceUrl}/Group/Sub/Repo/-/blob/${revision.headSha}/src/new.ts`,
      });
    });

    it.each(['collected', 'without_files', 'empty'])(
      'keeps completed zero-file %s metadata distinct from missing context',
      async state => {
        rows.set(`${root}/versions`, [{ ...version, state, real_size: '0' }]);
        rows.set(`${root}/versions/91`, { ...version, state, real_size: '0', diffs: [] });
        rows.set(`${root}/diffs`, []);
        const selected = await auth();
        expect(await listGitLabFiles(selected, identity, revision, null, versionId)).toEqual({
          items: [],
          nextCursor: null,
        });
        await expect(
          getGitLabFileContext(selected, identity, { ...contextInput, versionId })
        ).rejects.toMatchObject({ code: 'conflict' });
        expect((await getGitLabReview(selected, repository, '7')).counts).toEqual({
          commits: 1,
          files: 0,
          additions: 0,
          deletions: 0,
        });
      }
    );
  });

  it.each([
    { state: 'overflow', real_size: '1' },
    { state: 'overflow_commits_safe_size', real_size: '1' },
    { state: 'overflow_diff_files_limit', real_size: '1' },
    { state: 'overflow_diff_lines_limit', real_size: '1' },
    { state: 'collected', real_size: '1000+' },
  ])('retains explicit-version limit errors through both file reads: %j', async metadata => {
    rows.set(`${root}/versions/91`, { ...version, ...metadata, diffs: [diff] });
    const selected = await auth();
    expect(
      await Promise.allSettled([
        listGitLabFiles(selected, identity, revision, null, '91'),
        getGitLabFileContext(selected, identity, { ...contextInput, versionId: '91' }),
      ])
    ).toMatchObject([
      { status: 'rejected', reason: { code: 'response_too_large' } },
      { status: 'rejected', reason: { code: 'response_too_large' } },
    ]);
  });

  it.each(['headSha', 'baseSha', 'startSha'] as const)(
    'rejects a mismatched explicit-version %s through both file reads',
    async field => {
      const stale = { ...revision, [field]: 'd'.repeat(40) };
      const selected = await auth();
      expect(
        await Promise.allSettled([
          listGitLabFiles(selected, identity, stale, null, '91'),
          getGitLabFileContext(selected, identity, {
            ...contextInput,
            file: { ...contextInput.file, revision: stale },
            versionId: '91',
          }),
        ])
      ).toMatchObject([
        { status: 'rejected', reason: { code: 'conflict' } },
        { status: 'rejected', reason: { code: 'conflict' } },
      ]);
    }
  );

  // Both flags exclude patches: https://docs.gitlab.com/api/merge_requests/#list-merge-request-diffs
  describe.each(['collapsed', 'too_large'])('%s patches', flag => {
    it.each([
      { label: 'empty', patch: '' },
      { label: 'partial', patch: '@@ -1 +1 @@\n-old\n+partial' },
    ])('retains unknown counts for the $label patch beside complete files', async ({ patch }) => {
      const diffs = [
        diff,
        { ...diff, new_path: 'src/limited.ts', [flag]: true, diff: patch },
        { ...diff, new_path: 'src/complete.ts', diff: '@@ -0,0 +1,2 @@\n+first\n+second' },
      ];
      rows.set(`${root}/diffs`, diffs);
      rows.set(`${root}/versions`, [{ ...version, real_size: '3' }]);
      rows.set(`${root}/versions/91`, { ...version, real_size: '3', diffs });
      const selected = await auth();
      const [current, explicit, overview] = await Promise.all([
        listGitLabFiles(selected, identity, revision),
        listGitLabFiles(selected, identity, revision, null, '91'),
        getGitLabReview(selected, repository, '7'),
      ]);
      const expectedFiles = [
        { newPath: diff.new_path, content: 'available', additions: 1, deletions: 1 },
        {
          oldPath: diff.old_path,
          newPath: 'src/limited.ts',
          status: 'renamed',
          revision,
          content: 'truncated',
          patch: null,
          additions: null,
          deletions: null,
          canonicalUrl: `${instanceUrl}/Group/Sub/Repo/-/blob/${revision.headSha}/src/limited.ts`,
        },
        { newPath: 'src/complete.ts', content: 'available', additions: 2, deletions: 0 },
      ];
      expect({
        current: current.items,
        explicit: explicit.items,
        counts: overview.counts,
      }).toMatchObject({
        current: expectedFiles,
        explicit: expectedFiles,
        counts: { commits: 1, files: 3, additions: null, deletions: null },
      });
    });
  });

  it.each([null, undefined])('keeps absent patch %s counts unknown', async patch => {
    rows.set(`${root}/diffs`, [{ ...diff, diff: patch }]);
    const selected = await auth();
    const [files, overview] = await Promise.all([
      listGitLabFiles(selected, identity, revision),
      getGitLabReview(selected, repository, '7'),
    ]);
    expect({ files: files.items, counts: overview.counts }).toMatchObject({
      files: [{ content: 'unavailable', additions: null, deletions: null }],
      counts: { files: 1, additions: null, deletions: null },
    });
  });

  it('sums complete patches and confirmed empty patches as numeric counts', async () => {
    rows.set(`${root}/diffs`, [
      diff,
      { ...diff, new_path: 'src/complete.ts', diff: '@@ -0,0 +1,2 @@\n+first\n+second' },
      { ...diff, new_path: 'src/unchanged.ts', diff: '' },
    ]);
    const selected = await auth();
    expect((await listGitLabFiles(selected, identity, revision)).items).toMatchObject([
      { additions: 1, deletions: 1 },
      { additions: 2, deletions: 0 },
      { additions: 0, deletions: 0 },
    ]);
    expect((await getGitLabReview(selected, repository, '7')).counts).toEqual({
      commits: 1,
      files: 3,
      additions: 3,
      deletions: 1,
    });
  });
});
