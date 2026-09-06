import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import * as https from 'https';
import { PassThrough } from 'stream';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import { GitLabInstanceUrlError } from '@/lib/integrations/platforms/gitlab/instance-url';
import {
  getFileLines,
  getMergeRequest,
  getMergeState,
  listChangedFiles,
  listChecks,
  listDiscussions,
  listInbox,
} from './gitlab-read';
import { GitLabReviewError } from './gitlab-authorization';

// The bound transport runs through Node https.request; mirror adapter.test.ts.
jest.mock('https', () => ({
  request: jest.fn(),
}));

const mockGetIntegrationForOwner = jest.fn();
const mockGetValidGitLabToken = jest.fn();
const mockFetchGitLabMergeRequest = jest.fn();
const mockGetMRHeadCommit = jest.fn();
const mockGetMRDiffRefs = jest.fn();
const mockFetchGitLabRootTextFileAtRef = jest.fn();
const mockFetchGitLabUser = jest.fn();
const mockResolveGitLabUrlSafely = jest.fn();

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (owner: Owner, platform: string) =>
    mockGetIntegrationForOwner(owner, platform),
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getValidGitLabToken: (integration: PlatformIntegration, actor: unknown) =>
    mockGetValidGitLabToken(integration, actor),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  fetchGitLabMergeRequest: (params: unknown) => mockFetchGitLabMergeRequest(params),
  getMRHeadCommit: (...args: unknown[]) => mockGetMRHeadCommit(...args),
  getMRDiffRefs: (...args: unknown[]) => mockGetMRDiffRefs(...args),
  fetchGitLabRootTextFileAtRef: (...args: unknown[]) => mockFetchGitLabRootTextFileAtRef(...args),
  fetchGitLabUser: (...args: unknown[]) => mockFetchGitLabUser(...args),
}));

// Keep the real URL builder; stub the resolved-URL guard so unit tests need no
// network. Default (set in beforeEach): no pinned address, so requests keep the
// plain fetch transport the assertions read. Transport tests rebind it per test.
jest.mock('@/lib/integrations/platforms/gitlab/instance-url', () => {
  const actual = jest.requireActual('@/lib/integrations/platforms/gitlab/instance-url');
  return {
    ...actual,
    resolveGitLabUrlSafely: (urlString: string) => mockResolveGitLabUrlSafely(urlString),
  };
});

const mockHttpsRequest = https.request as unknown as jest.Mock;

const OWNER: { type: 'user'; userId: string } = { type: 'user', userId: 'user_1' };
const INSTANCE_URL = 'https://gitlab.example.com';
const PROJECT_PATH = 'group/sub/repo';

/** Await a rejection and return it typed, without a success-branch union. */
async function captureRejection(promise: Promise<unknown>): Promise<GitLabReviewError> {
  try {
    await promise;
  } catch (reason) {
    return reason as GitLabReviewError;
  }
  throw new Error('Expected the call to reject.');
}

const integrationRow = {
  id: 'intg_1',
  platform: 'gitlab',
  integration_status: 'active',
  owned_by_user_id: 'user_1',
  owned_by_organization_id: null,
  metadata: { gitlab_instance_url: INSTANCE_URL },
  repositories: [{ id: 7, name: 'repo', full_name: PROJECT_PATH, private: true }],
} as unknown as PlatformIntegration;

const mrFixture = {
  id: 100,
  iid: 12,
  title: 'Add nested deploy script',
  description: 'Body here',
  state: 'opened',
  draft: false,
  source_branch: 'feature/deploy',
  target_branch: 'main',
  sha: 'sha-head',
  diff_refs: { base_sha: 'sha-base', head_sha: 'sha-head', start_sha: 'sha-start' },
  web_url: `${INSTANCE_URL}/group/sub/repo/-/merge_requests/12`,
  author: { id: 1, username: 'alice', name: 'Alice', avatar_url: null },
  created_at: '2026-01-02T00:00:00Z',
  updated_at: '2026-01-03T00:00:00Z',
  has_conflicts: false,
  merge_status: 'can_be_merged',
  head_pipeline: {
    id: 1,
    sha: 'sha-head',
    ref: 'feature/deploy',
    status: 'success',
    web_url: `${INSTANCE_URL}/-/pipelines/1`,
  },
  references: { full: 'group/sub/repo!12' },
};

const diffFixture = [
  {
    old_path: 'scripts/deploy.sh',
    new_path: 'scripts/deploy.sh',
    new_file: true,
    renamed_file: false,
    deleted_file: false,
    diff: '@@ -0,0 +1,2 @@\n+set -e\n+echo done\n',
  },
  {
    old_path: 'README.md',
    new_path: 'README.md',
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: '@@ -1,2 +1,2 @@\n-old\n+new\n',
  },
];

let fetchMock: jest.Mock;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lastFetchUrl(): URL {
  const last = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return new URL(String(last[0]));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveGitLabUrlSafely.mockImplementation(async (urlString: string) => ({
    url: new URL(urlString),
  }));
  mockGetIntegrationForOwner.mockResolvedValue(integrationRow);
  mockGetValidGitLabToken.mockResolvedValue('glpat-mock-token');
  mockFetchGitLabMergeRequest.mockResolvedValue(mrFixture);
  mockGetMRHeadCommit.mockResolvedValue('sha-head');
  mockGetMRDiffRefs.mockResolvedValue({
    baseSha: 'sha-base',
    headSha: 'sha-head',
    startSha: 'sha-start',
  });
  fetchMock = jest.fn();
  fetchMock.mockImplementation((url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/diffs')) return Promise.resolve(jsonResponse(diffFixture));
    if (path.endsWith('/discussions')) return Promise.resolve(jsonResponse([]));
    if (path.endsWith('/pipelines')) return Promise.resolve(jsonResponse([]));
    if (path.endsWith('/approvals'))
      return Promise.resolve(jsonResponse({ approvals_required: 0, approvals_left: 0 }));
    return Promise.resolve(jsonResponse([]));
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getMergeRequest', () => {
  it('maps detail, head sha, diff refs, and diff counts into the s1 summary', async () => {
    const summary = await getMergeRequest(OWNER, PROJECT_PATH, 12);

    expect(summary).toMatchObject({
      ref: { platform: 'gitlab', projectPath: PROJECT_PATH, mrIid: 12, instanceHint: INSTANCE_URL },
      title: 'Add nested deploy script',
      body: 'Body here',
      author: { login: 'alice', avatarUrl: null },
      state: 'open',
      draft: false,
      headRef: 'feature/deploy',
      baseRef: 'main',
      headSha: 'sha-head',
      changedFiles: 2,
      additions: 3,
      deletions: 1,
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-03T00:00:00Z',
    });
    // Adapter helpers were called with the SERVER-DERIVED instance URL.
    expect(mockFetchGitLabMergeRequest).toHaveBeenCalledWith({
      accessToken: 'glpat-mock-token',
      projectId: PROJECT_PATH,
      mrIid: 12,
      instanceUrl: INSTANCE_URL,
    });
  });

  it('marks a draft MR draft from the title when the flag is absent', async () => {
    mockFetchGitLabMergeRequest.mockResolvedValue({
      ...mrFixture,
      draft: undefined,
      work_in_progress: undefined,
      title: 'Draft: unfinished work',
    });

    const summary = await getMergeRequest(OWNER, PROJECT_PATH, 12);

    expect(summary.draft).toBe(true);
  });

  it('authorizes before any request: an unknown project never reaches GitLab', async () => {
    await expect(getMergeRequest(OWNER, 'other/project', 12)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mockFetchGitLabMergeRequest).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listChangedFiles', () => {
  it('returns mapped files with per-file counts and a next cursor only for a full page', async () => {
    const page = await listChangedFiles(OWNER, PROJECT_PATH, 12);

    expect(page.files[0]).toMatchObject({
      path: 'scripts/deploy.sh',
      previousPath: null,
      status: 'added',
      additions: 2,
      deletions: 0,
      patchMissing: false,
    });
    expect(page.files[1]).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
    expect(page.nextCursor).toBeNull();
  });

  it('keeps page identity in the cursor and requests the next page', async () => {
    const manyDiffs = Array.from({ length: 50 }, (_, index) => ({
      old_path: `f${index}.ts`,
      new_path: `f${index}.ts`,
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      diff: '+x\n',
    }));
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(manyDiffs)));

    const first = await listChangedFiles(OWNER, PROJECT_PATH, 12);
    expect(first.nextCursor).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(String(first.nextCursor), 'base64url').toString('utf8'));
    expect(decoded).toEqual({ identity: PROJECT_PATH, page: 2 });

    await listChangedFiles(OWNER, PROJECT_PATH, 12, String(first.nextCursor));
    expect(lastFetchUrl().searchParams.get('page')).toBe('2');
    expect(lastFetchUrl().searchParams.get('per_page')).toBe('50');
  });

  it('never trusts a foreign cursor to switch project: it restarts at page 1', async () => {
    const foreign = Buffer.from(
      JSON.stringify({ identity: 'victim/project', page: 4 }),
      'utf8'
    ).toString('base64url');

    await listChangedFiles(OWNER, PROJECT_PATH, 12, foreign);

    expect(lastFetchUrl().searchParams.get('page')).toBe('1');
    expect(lastFetchUrl().pathname).toContain(encodeURIComponent(PROJECT_PATH));
    expect(lastFetchUrl().pathname).not.toContain('victim');
  });
});

describe('getFileLines', () => {
  it('returns the 1-based inclusive slice with the total line count', async () => {
    mockFetchGitLabRootTextFileAtRef.mockResolvedValue('a\nb\nc\nd\ne');

    const result = await getFileLines(OWNER, PROJECT_PATH, 'sha-head', 'file.txt', 2, 4);

    expect(result).toEqual({ lines: ['b', 'c', 'd'], totalLines: 5 });
    expect(mockFetchGitLabRootTextFileAtRef).toHaveBeenCalledWith(
      'glpat-mock-token',
      PROJECT_PATH,
      'file.txt',
      'sha-head',
      INSTANCE_URL
    );
  });

  it('refuses a missing file as non-retryable not_found', async () => {
    mockFetchGitLabRootTextFileAtRef.mockResolvedValue(null);

    await expect(
      getFileLines(OWNER, PROJECT_PATH, 'sha-head', 'gone.txt', 1, 5)
    ).rejects.toMatchObject({ kind: 'not_found', retryable: false });
  });
});

describe('listDiscussions', () => {
  it('maps discussions to threads with path, line, side, resolvable, and resolved', async () => {
    const discussions = [
      {
        id: 'disc-1',
        individual_note: false,
        notes: [
          {
            id: 11,
            body: 'Guard this parse',
            author: { id: 1, username: 'alice', name: 'Alice' },
            created_at: '2026-01-02T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
            system: false,
            noteable_id: 100,
            noteable_type: 'MergeRequest',
            noteable_iid: 12,
            resolvable: true,
            resolved: false,
            position: {
              base_sha: 'sha-base',
              start_sha: 'sha-start',
              head_sha: 'sha-head',
              old_path: 'src/a.ts',
              new_path: 'src/a.ts',
              position_type: 'text',
              old_line: null,
              new_line: 42,
            },
          },
          {
            id: 12,
            body: 'Merged the guard',
            author: { id: 2, username: 'bob', name: 'Bob' },
            created_at: '2026-01-02T01:00:00Z',
            updated_at: '2026-01-02T01:00:00Z',
            system: false,
            noteable_id: 100,
            noteable_type: 'MergeRequest',
            noteable_iid: 12,
            resolvable: true,
            resolved: false,
          },
        ],
      },
      {
        id: 'disc-2',
        individual_note: true,
        notes: [
          {
            id: 13,
            body: 'Overall looks good',
            author: { id: 2, username: 'bob', name: 'Bob' },
            created_at: '2026-01-02T02:00:00Z',
            updated_at: '2026-01-02T02:00:00Z',
            system: false,
            noteable_id: 100,
            noteable_type: 'MergeRequest',
            noteable_iid: 12,
            resolvable: false,
          },
        ],
      },
      {
        id: 'disc-3',
        individual_note: false,
        notes: [
          {
            id: 14,
            body: 'resolved thread note',
            author: { id: 1, username: 'alice', name: 'Alice' },
            created_at: '2026-01-02T03:00:00Z',
            updated_at: '2026-01-02T03:00:00Z',
            system: false,
            noteable_id: 100,
            noteable_type: 'MergeRequest',
            noteable_iid: 12,
            resolvable: true,
            resolved: true,
          },
          {
            id: 15,
            body: '',
            author: { id: 3, username: 'root', name: 'Root' },
            created_at: '2026-01-02T04:00:00Z',
            updated_at: '2026-01-02T04:00:00Z',
            system: true,
            noteable_id: 100,
            noteable_type: 'MergeRequest',
            noteable_iid: 12,
            resolvable: false,
          },
        ],
      },
    ];
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(discussions)));

    const page = await listDiscussions(OWNER, PROJECT_PATH, 12);

    expect(page.threads).toHaveLength(3);
    expect(page.threads[0]).toMatchObject({
      threadId: 'disc-1',
      resolved: false,
      resolvable: true,
      path: 'src/a.ts',
      line: 42,
      side: 'RIGHT',
    });
    expect(page.threads[0]?.comments).toHaveLength(2);
    expect(page.threads[1]).toMatchObject({
      threadId: 'disc-2',
      resolvable: false,
      path: null,
      line: null,
      side: null,
    });
    expect(page.threads[2]).toMatchObject({ threadId: 'disc-3', resolved: true });
    // System notes never appear as comments.
    expect(page.threads[2]?.comments.map(comment => comment.commentId)).toEqual(['14']);
  });

  it('reuses the same cursor rule: foreign identity restarts at page 1', async () => {
    const foreign = Buffer.from(
      JSON.stringify({ identity: 'other/repo', page: 9 }),
      'utf8'
    ).toString('base64url');

    await listDiscussions(OWNER, PROJECT_PATH, 12, foreign);

    expect(lastFetchUrl().searchParams.get('page')).toBe('1');
  });
});

describe('listChecks', () => {
  it('lists pipelines for the MR head commit with status and details URL', async () => {
    const pipelines = [
      {
        id: 41,
        sha: 'sha-head',
        ref: 'feature/deploy',
        status: 'running',
        web_url: `${INSTANCE_URL}/group/sub/repo/-/pipelines/41`,
        name: null,
      },
      {
        id: 42,
        sha: 'sha-head',
        ref: 'feature/deploy',
        status: 'success',
        web_url: `${INSTANCE_URL}/group/sub/repo/-/pipelines/42`,
        name: 'e2e',
      },
    ];
    fetchMock.mockImplementation(url => {
      if (new URL(String(url)).pathname.endsWith('/pipelines')) {
        return Promise.resolve(jsonResponse(pipelines));
      }
      return Promise.resolve(jsonResponse([]));
    });

    const result = await listChecks(OWNER, PROJECT_PATH, 12);

    expect(lastFetchUrl().searchParams.get('sha')).toBe('sha-head');
    expect(result.checks).toEqual([
      {
        name: 'feature/deploy',
        status: 'running',
        conclusion: null,
        detailsUrl: `${INSTANCE_URL}/group/sub/repo/-/pipelines/41`,
      },
      {
        name: 'e2e',
        status: 'success',
        conclusion: 'success',
        detailsUrl: `${INSTANCE_URL}/group/sub/repo/-/pipelines/42`,
      },
    ]);
  });
});

describe('listInbox', () => {
  it('queries opened merge requests where the acting user is the reviewer', async () => {
    mockFetchGitLabUser.mockResolvedValue({
      id: 1,
      username: 'reviewer',
      name: 'Reviewer',
      email: 'r@example.com',
      avatar_url: '',
      web_url: `${INSTANCE_URL}/reviewer`,
    });
    const globalMrs = [
      {
        ...mrFixture,
        references: { full: 'group/sub/repo!12' },
      },
      {
        ...mrFixture,
        iid: 99,
        references: { full: 'team/other!99' },
        updated_at: '2026-01-04T00:00:00Z',
      },
    ];
    fetchMock.mockImplementation(url => {
      if (new URL(String(url)).pathname === '/api/v4/merge_requests') {
        return Promise.resolve(jsonResponse(globalMrs));
      }
      return Promise.resolve(jsonResponse([]));
    });

    const page = await listInbox(OWNER);

    const url = lastFetchUrl();
    expect(url.pathname).toBe('/api/v4/merge_requests');
    expect(url.searchParams.get('reviewer_username')).toBe('reviewer');
    expect(url.searchParams.get('state')).toBe('opened');
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.ref).toEqual({
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      mrIid: 12,
      instanceHint: INSTANCE_URL,
    });
    expect(page.items[1]?.ref).toMatchObject({ projectPath: 'team/other', mrIid: 99 });
  });

  it('skips rows with no resolvable project path instead of guessing', async () => {
    mockFetchGitLabUser.mockResolvedValue({
      id: 1,
      username: 'reviewer',
      name: 'R',
      email: '',
      avatar_url: '',
      web_url: '',
    });
    fetchMock.mockImplementation(url => {
      if (new URL(String(url)).pathname === '/api/v4/merge_requests') {
        return Promise.resolve(
          jsonResponse([{ ...mrFixture, references: undefined, web_url: 'not a url' }])
        );
      }
      return Promise.resolve(jsonResponse([]));
    });

    const page = await listInbox(OWNER);

    expect(page.items).toEqual([]);
  });
});

describe('getMergeState', () => {
  function routeResponses(overrides: {
    settings?: Record<string, unknown>;
    approvals?: unknown;
    discussions?: unknown[];
  }) {
    fetchMock.mockImplementation(url => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/approvals')) {
        return overrides.approvals === undefined
          ? Promise.resolve(jsonResponse({ message: '404 Not found' }, 404))
          : Promise.resolve(jsonResponse(overrides.approvals));
      }
      if (path.endsWith('/discussions')) {
        return Promise.resolve(jsonResponse(overrides.discussions ?? []));
      }
      if (path.endsWith('/diffs')) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse(overrides.settings ?? {}));
    });
  }

  it('reports blocked reasons from settings, approvals, conflicts, and pipeline', async () => {
    routeResponses({
      settings: {
        only_allow_merge_if_pipeline_succeeds: true,
        only_allow_merge_if_all_discussions_are_resolved: true,
      },
      approvals: { approvals_required: 3, approvals_left: 2 },
      discussions: [
        {
          id: 'd1',
          individual_note: false,
          notes: [
            {
              id: 1,
              body: 'x',
              author: { id: 1, username: 'a', name: 'A' },
              created_at: '',
              updated_at: '',
              system: false,
              noteable_id: 1,
              noteable_type: 'MergeRequest',
              noteable_iid: 12,
              resolvable: true,
              resolved: false,
            },
          ],
        },
      ],
    });
    mockFetchGitLabMergeRequest.mockResolvedValue({
      ...mrFixture,
      has_conflicts: true,
      merge_status: 'cannot_be_merged',
      head_pipeline: { ...mrFixture.head_pipeline, status: 'failed' },
    });

    const state = await getMergeState(OWNER, PROJECT_PATH, 12);

    expect(state).toMatchObject({
      canMerge: false,
      approvalsRequired: 3,
      pipelineMustSucceed: true,
      conflicts: true,
    });
    expect(state.blockedReasons.map(reason => reason.code)).toEqual(
      expect.arrayContaining(['conflicts', 'required_approvals', 'failing_pipeline', 'other'])
    );
  });

  it('allows merge when every gate is satisfied', async () => {
    routeResponses({
      settings: {
        only_allow_merge_if_pipeline_succeeds: true,
        only_allow_merge_if_all_discussions_are_resolved: true,
      },
      approvals: { approvals_required: 1, approvals_left: 0 },
      discussions: [],
    });

    const state = await getMergeState(OWNER, PROJECT_PATH, 12);

    expect(state).toMatchObject({
      canMerge: true,
      approvalsRequired: 1,
      pipelineMustSucceed: true,
      conflicts: false,
      blockedReasons: [],
    });
  });

  it('treats a 404 approvals endpoint (no approval rules) as no approval gate', async () => {
    routeResponses({ settings: {}, approvals: undefined });

    const state = await getMergeState(OWNER, PROJECT_PATH, 12);

    expect(state.approvalsRequired).toBe(0);
    expect(state.canMerge).toBe(true);
  });

  it('blocks a draft with the draft reason', async () => {
    routeResponses({ settings: {} });
    mockFetchGitLabMergeRequest.mockResolvedValue({ ...mrFixture, draft: true });

    const state = await getMergeState(OWNER, PROJECT_PATH, 12);

    expect(state.canMerge).toBe(false);
    expect(state.blockedReasons.map(reason => reason.code)).toContain('draft');
  });
});

describe('provider failures reach the four mobile states', () => {
  it('classifies a 5xx diffs response as retryable', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ message: 'boom' }, 503)));

    const error = await captureRejection(listChangedFiles(OWNER, PROJECT_PATH, 12));
    expect(error).toBeInstanceOf(GitLabReviewError);
    expect(error.kind).toBe('retryable');
    expect(error.retryable).toBe(true);
  });

  it('classifies a 404 discussion response as not_found without leaking the instance URL', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ message: '404' }, 404)));

    const error = await captureRejection(listDiscussions(OWNER, PROJECT_PATH, 12));
    expect(error.kind).toBe('not_found');
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain('gitlab.example.com');
    expect(error.message).not.toContain('glpat-mock-token');
  });

  it('classifies an adapter 403 throw as forbidden', async () => {
    mockFetchGitLabMergeRequest.mockRejectedValue(new Error('GitLab MR fetch failed: 403'));

    await expect(getMergeState(OWNER, PROJECT_PATH, 12)).rejects.toMatchObject({
      kind: 'forbidden',
      retryable: false,
    });
  });

  it('classifies a network failure as retryable', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));

    await expect(listChecks(OWNER, PROJECT_PATH, 12)).rejects.toMatchObject({
      kind: 'retryable',
      retryable: true,
    });
  });
});

/**
 * Fake a Node https.request round-trip, mirroring adapter.test.ts's
 * mockSelfHostedGitLabResponse: the bound transport never touches global
 * fetch, so the response is streamed through a PassThrough.
 */
function mockBoundResponse(args: { status: number; json?: unknown; body?: Buffer }) {
  mockHttpsRequest.mockImplementationOnce((_options, callback) => {
    const response = new PassThrough() as PassThrough & {
      statusCode?: number;
      statusMessage?: string;
      headers: Record<string, string>;
    };
    response.statusCode = args.status;
    response.statusMessage = 'OK';
    response.headers = { 'content-type': 'application/json' };
    const request = new EventEmitter() as EventEmitter & {
      write: jest.Mock;
      end: jest.Mock;
      destroy: jest.Mock;
      setTimeout: jest.Mock;
    };
    request.write = jest.fn();
    request.destroy = jest.fn();
    request.setTimeout = jest.fn();
    request.end = jest.fn(() => {
      callback?.(response as never);
      response.end(args.body ?? Buffer.from(JSON.stringify(args.json ?? {})));
    });
    return request as never;
  });
}

type BoundRequestOptions = Omit<https.RequestOptions, 'lookup'> & {
  servername?: string;
  lookup: (
    hostname: string,
    options: unknown,
    callback: (e: null, a: string, f: number) => void
  ) => void;
};

describe('request transport binds to the resolved address (no DNS rebinding)', () => {
  beforeEach(() => {
    mockResolveGitLabUrlSafely.mockImplementation(async (urlString: string) => ({
      url: new URL(urlString),
      address: '93.184.216.34',
      family: 4,
    }));
  });

  it('sends the self-managed request through the pinned transport, not global fetch', async () => {
    mockBoundResponse({ status: 200, json: diffFixture });

    const page = await listChangedFiles(OWNER, PROJECT_PATH, 12);

    expect(page.files).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
    const options = mockHttpsRequest.mock.calls[0][0] as BoundRequestOptions;
    expect(options.hostname).toBe('gitlab.example.com');
    expect(options.path).toContain('/merge_requests/12/diffs');
    // TLS still verifies the original host, and the socket can only ever get
    // the address the guard resolved — there is no second DNS lookup.
    expect(options.servername).toBe('gitlab.example.com');
    let pinnedAddress = '';
    options.lookup('gitlab.example.com', {}, (_error, address) => {
      pinnedAddress = address;
    });
    expect(pinnedAddress).toBe('93.184.216.34');
    const headers = options.headers as Record<string, string>;
    expect(headers.authorization ?? headers.Authorization).toBe('Bearer glpat-mock-token');
  });

  it('refuses the request when the guard rejects the resolved host, before any socket', async () => {
    mockResolveGitLabUrlSafely.mockRejectedValue(
      new GitLabInstanceUrlError(
        'GitLab instance URL host resolves to an address that is not allowed.'
      )
    );

    await expect(listChangedFiles(OWNER, PROJECT_PATH, 12)).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('caps a hostile bound response at the adapter 10 MB limit', async () => {
    mockBoundResponse({ status: 200, body: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61) });

    await expect(listChangedFiles(OWNER, PROJECT_PATH, 12)).rejects.toMatchObject({
      kind: 'retryable',
      retryable: true,
    });
  });

  it('classifies a bound 404 as not_found without leaking the instance URL', async () => {
    mockBoundResponse({ status: 404, json: { message: '404 Project Not Found' } });

    const error = await captureRejection(listDiscussions(OWNER, PROJECT_PATH, 12));

    expect(error.kind).toBe('not_found');
    expect(error.message).not.toContain('gitlab.example.com');
    expect(error.message).not.toContain('glpat-mock-token');
  });
});
