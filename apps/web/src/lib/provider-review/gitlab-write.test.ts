import { describe, expect, it, beforeEach } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import { GitLabReviewError } from './gitlab-authorization';
import {
  GITLAB_AUTO_MERGE_NO_PIPELINE_REASON,
  GITLAB_MR_REVIEW_CAPABILITIES,
  GITLAB_REQUEST_CHANGES_UNSUPPORTED_REASON,
  GITLAB_STALE_HEAD_REASON,
  addComment,
  deleteBranch,
  disableAutoMerge,
  enableAutoMerge,
  mergePullRequest,
  replyToDiscussion,
  resolveThread,
  submitReview,
  unresolveThread,
} from './gitlab-write';

const mockGetIntegrationForOwner = jest.fn();
const mockGetValidGitLabToken = jest.fn();
const mockCreateMRNote = jest.fn();
const mockFetchGitLabMergeRequest = jest.fn();

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (owner: Owner, platform: string) =>
    mockGetIntegrationForOwner(owner, platform),
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getValidGitLabToken: (integration: PlatformIntegration, actor: unknown) =>
    mockGetValidGitLabToken(integration, actor),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  createMRNote: (...args: unknown[]) => mockCreateMRNote(...args),
  fetchGitLabMergeRequest: (params: unknown) => mockFetchGitLabMergeRequest(params),
  fetchGitLabUser: jest.fn(),
  fetchGitLabRootTextFileAtRef: jest.fn(),
  getMRHeadCommit: jest.fn(),
  getMRDiffRefs: jest.fn(),
}));

jest.mock('@/lib/integrations/platforms/gitlab/instance-url', () => {
  const actual = jest.requireActual('@/lib/integrations/platforms/gitlab/instance-url');
  return {
    ...actual,
    // No pinned address → requests keep the plain fetch transport these
    // assertions read; the bound transport is covered in gitlab-read.test.ts.
    resolveGitLabUrlSafely: jest.fn(async (urlString: string) => ({ url: new URL(urlString) })),
  };
});

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
const TARGET = { owner: OWNER, projectPath: PROJECT_PATH, mrIid: 12 };

const integrationRow = {
  id: 'intg_1',
  platform: 'gitlab',
  integration_status: 'active',
  owned_by_user_id: 'user_1',
  owned_by_organization_id: null,
  metadata: { gitlab_instance_url: INSTANCE_URL },
  repositories: [{ id: 7, name: 'repo', full_name: PROJECT_PATH, private: true }],
} as unknown as PlatformIntegration;

function openMrFixture(headSha: string, extra: Record<string, unknown> = {}) {
  return {
    id: 100,
    iid: 12,
    title: 'Add nested deploy script',
    description: null,
    state: 'opened',
    draft: false,
    source_branch: 'feature/deploy',
    target_branch: 'main',
    sha: headSha,
    diff_refs: { base_sha: 'sha-base', head_sha: headSha, start_sha: 'sha-start' },
    web_url: `${INSTANCE_URL}/group/sub/repo/-/merge_requests/12`,
    author: { id: 1, username: 'alice', name: 'Alice' },
    ...extra,
  };
}

let fetchMock: jest.Mock;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lastRequest(): { url: URL; init: RequestInit } {
  const last = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: new URL(String(last[0])), init: (last[1] ?? {}) as RequestInit };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetIntegrationForOwner.mockResolvedValue(integrationRow);
  mockGetValidGitLabToken.mockResolvedValue('glpat-mock-token');
  mockCreateMRNote.mockResolvedValue(undefined);
  mockFetchGitLabMergeRequest.mockResolvedValue(openMrFixture('sha-head'));
  fetchMock = jest.fn().mockResolvedValue(jsonResponse({ state: 'opened' }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('addComment / replyToDiscussion', () => {
  it('posts a project note with the server-derived credentials', async () => {
    const result = await addComment({ ...TARGET, body: 'Ship it', operationKey: 'op-1' });

    expect(result).toEqual({ done: true, replayed: false });
    expect(mockCreateMRNote).toHaveBeenCalledWith(
      'glpat-mock-token',
      PROJECT_PATH,
      12,
      'Ship it',
      INSTANCE_URL
    );
  });

  it('replies inside a discussion thread', async () => {
    const result = await replyToDiscussion({
      ...TARGET,
      discussionId: 'disc-1',
      body: 'Fixed',
      operationKey: 'op-2',
    });

    expect(result).toEqual({ done: true, replayed: false });
    const { url, init } = lastRequest();
    expect(init.method).toBe('POST');
    expect(url.pathname).toBe(
      `/api/v4/projects/${encodeURIComponent(PROJECT_PATH)}/merge_requests/12/discussions/disc-1/notes`
    );
    expect(JSON.parse(String(init.body))).toEqual({ body: 'Fixed' });
  });
});

describe('submitReview', () => {
  it('approve posts the approval plus an optional summary note', async () => {
    const result = await submitReview({ ...TARGET, event: 'approve', body: 'LGTM' });

    expect(result).toEqual({ done: true, replayed: false });
    const { url, init } = lastRequest();
    expect(url.pathname).toBe(
      `/api/v4/projects/${encodeURIComponent(PROJECT_PATH)}/merge_requests/12/approve`
    );
    expect(init.method).toBe('POST');
    expect(mockCreateMRNote).toHaveBeenCalledWith(
      'glpat-mock-token',
      PROJECT_PATH,
      12,
      'LGTM',
      INSTANCE_URL
    );
  });

  it('approve without a body posts no note', async () => {
    await submitReview({ ...TARGET, event: 'approve' });

    expect(mockCreateMRNote).not.toHaveBeenCalled();
  });

  it('comment posts a note and never calls approve', async () => {
    await submitReview({ ...TARGET, event: 'comment', body: 'Nit' });

    expect(mockCreateMRNote).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('request_changes is refused with the exact reason and no provider call', async () => {
    const error = await captureRejection(
      submitReview({ ...TARGET, event: 'request_changes', body: 'Nope' })
    );

    expect(error).toBeInstanceOf(GitLabReviewError);
    expect(error.kind).toBe('bad_request');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(GITLAB_REQUEST_CHANGES_UNSUPPORTED_REASON);
    // Never a silent fallback to another event:
    expect(mockCreateMRNote).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the capability list excludes request_changes', () => {
    expect(GITLAB_MR_REVIEW_CAPABILITIES.reviewEvents).toEqual(['approve', 'comment']);
    expect(GITLAB_MR_REVIEW_CAPABILITIES.reviewEvents).not.toContain('request_changes');
  });
});

describe('resolveThread / unresolveThread', () => {
  function discussionFixture(resolved: boolean) {
    return {
      id: 'disc-1',
      individual_note: false,
      notes: [
        {
          id: 11,
          body: 'Guard this',
          author: { id: 1, username: 'alice', name: 'Alice' },
          created_at: '',
          updated_at: '',
          system: false,
          noteable_id: 100,
          noteable_type: 'MergeRequest',
          noteable_iid: 12,
          resolvable: true,
          resolved,
        },
      ],
    };
  }

  it('PUTs the discussion resolved flag', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(discussionFixture(false)))
      .mockResolvedValueOnce(jsonResponse(discussionFixture(true)));

    const result = await resolveThread({ ...TARGET, discussionId: 'disc-1' });

    expect(result).toEqual({ done: true, replayed: false });
    const { url, init } = lastRequest();
    expect(init.method).toBe('PUT');
    expect(url.pathname).toBe(
      `/api/v4/projects/${encodeURIComponent(PROJECT_PATH)}/merge_requests/12/discussions/disc-1`
    );
    expect(url.searchParams.get('resolved')).toBe('true');
  });

  it('reports replayed without a write when the thread is already resolved', async () => {
    fetchMock.mockResolvedValue(jsonResponse(discussionFixture(true)));

    const result = await resolveThread({ ...TARGET, discussionId: 'disc-1' });

    expect(result).toEqual({ done: true, replayed: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('unresolveThread clears the flag', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(discussionFixture(true)))
      .mockResolvedValueOnce(jsonResponse(discussionFixture(false)));

    const result = await unresolveThread({ ...TARGET, discussionId: 'disc-1' });

    expect(result).toEqual({ done: true, replayed: false });
    expect(lastRequest().url.searchParams.get('resolved')).toBe('false');
  });

  it('refuses to resolve a non-resolvable discussion', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'disc-9',
        individual_note: true,
        notes: [
          {
            id: 20,
            body: 'note',
            author: { id: 1, username: 'alice', name: 'Alice' },
            created_at: '',
            updated_at: '',
            system: false,
            noteable_id: 100,
            noteable_type: 'MergeRequest',
            noteable_iid: 12,
            resolvable: false,
          },
        ],
      })
    );

    await expect(resolveThread({ ...TARGET, discussionId: 'disc-9' })).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
    });
  });
});

describe('mergePullRequest', () => {
  it('re-fetches the MR, fences the head, and merges the exact revision', async () => {
    const result = await mergePullRequest({
      ...TARGET,
      expectedHeadSha: 'sha-head',
      squash: true,
      shouldRemoveSourceBranch: true,
      operationKey: 'op-merge',
    });

    expect(result).toEqual({ done: true, replayed: false });
    expect(mockFetchGitLabMergeRequest).toHaveBeenCalled();
    const { url, init } = lastRequest();
    expect(init.method).toBe('PUT');
    expect(url.pathname).toBe(
      `/api/v4/projects/${encodeURIComponent(PROJECT_PATH)}/merge_requests/12/merge`
    );
    expect(JSON.parse(String(init.body))).toEqual({
      sha: 'sha-head',
      squash: true,
      should_remove_source_branch: true,
    });
  });

  it('refuses a stale revision with the exact reason and never merges', async () => {
    mockFetchGitLabMergeRequest.mockResolvedValue(openMrFixture('sha-moved'));

    const error = await captureRejection(
      mergePullRequest({ ...TARGET, expectedHeadSha: 'sha-head' })
    );

    expect(error).toBeInstanceOf(GitLabReviewError);
    expect(error.kind).toBe('stale_head');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(GITLAB_STALE_HEAD_REASON);
    // No merge effect, no redirect to the new head:
    const mergeCall = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/merge'));
    expect(mergeCall).toBeUndefined();
  });

  it('reports replayed when the MR is already merged', async () => {
    mockFetchGitLabMergeRequest.mockResolvedValue({
      ...openMrFixture('sha-head'),
      state: 'merged',
    });

    const result = await mergePullRequest({ ...TARGET, expectedHeadSha: 'sha-head' });

    expect(result).toEqual({ done: true, replayed: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a closed MR with a non-retryable bad_request', async () => {
    mockFetchGitLabMergeRequest.mockResolvedValue({
      ...openMrFixture('sha-head'),
      state: 'closed',
    });

    await expect(
      mergePullRequest({ ...TARGET, expectedHeadSha: 'sha-head' })
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a provider 409 as the same stale-head reason', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Branch cannot be merged' }, 409));

    const error = await captureRejection(
      mergePullRequest({ ...TARGET, expectedHeadSha: 'sha-head' })
    );

    expect(error.kind).toBe('stale_head');
    expect(error.message).toBe(
      'The merge request changed since it was loaded. Reload the merge request and try again.'
    );
  });
});

describe('enableAutoMerge', () => {
  it('arms merge-when-pipeline-succeeds through the merge endpoint with the head fence as sha', async () => {
    mockFetchGitLabMergeRequest.mockResolvedValue(
      openMrFixture('sha-head', { head_pipeline: { status: 'running' } })
    );

    const result = await enableAutoMerge({ ...TARGET, expectedHeadSha: 'sha-head' });

    expect(result).toEqual({ done: true, replayed: false });
    const { url, init } = lastRequest();
    expect(init.method).toBe('PUT');
    // The plain update endpoint silently ignores this attribute, so the
    // request must hit /merge (GitLab docs: merge when pipeline succeeds),
    // and the caller's head fence travels as `sha`.
    expect(url.pathname).toBe(
      `/api/v4/projects/${encodeURIComponent(PROJECT_PATH)}/merge_requests/12/merge`
    );
    expect(JSON.parse(String(init.body))).toEqual({
      merge_when_pipeline_succeeds: true,
      sha: 'sha-head',
    });
  });

  it('reports replayed when auto-merge is already enabled', async () => {
    mockFetchGitLabMergeRequest.mockResolvedValue(
      openMrFixture('sha-head', { merge_when_pipeline_succeeds: true })
    );

    const result = await enableAutoMerge({ ...TARGET, expectedHeadSha: 'sha-head' });

    expect(result).toEqual({ done: true, replayed: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a stale head with the exact reason and never arms', async () => {
    mockFetchGitLabMergeRequest.mockResolvedValue(
      openMrFixture('sha-moved', { head_pipeline: { status: 'running' } })
    );

    const error = await captureRejection(
      enableAutoMerge({ ...TARGET, expectedHeadSha: 'sha-head' })
    );

    expect(error.kind).toBe('stale_head');
    expect(error.message).toBe(GITLAB_STALE_HEAD_REASON);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an MR with no pipeline instead of letting GitLab merge immediately', async () => {
    mockFetchGitLabMergeRequest.mockResolvedValue(
      openMrFixture('sha-head', { head_pipeline: null })
    );

    const error = await captureRejection(
      enableAutoMerge({ ...TARGET, expectedHeadSha: 'sha-head' })
    );

    expect(error).toBeInstanceOf(GitLabReviewError);
    expect(error.kind).toBe('bad_request');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(GITLAB_AUTO_MERGE_NO_PIPELINE_REASON);
    const mergeCall = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/merge'));
    expect(mergeCall).toBeUndefined();
  });

  it('refuses when the latest pipeline already finished', async () => {
    mockFetchGitLabMergeRequest.mockResolvedValue(
      openMrFixture('sha-head', { head_pipeline: { status: 'success' } })
    );

    await expect(
      enableAutoMerge({ ...TARGET, expectedHeadSha: 'sha-head' })
    ).rejects.toMatchObject({
      kind: 'bad_request',
      message: GITLAB_AUTO_MERGE_NO_PIPELINE_REASON,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('disableAutoMerge', () => {
  it('cancels through the dedicated cancel endpoint, not the update endpoint', async () => {
    mockFetchGitLabMergeRequest.mockResolvedValue(
      openMrFixture('sha-head', { merge_when_pipeline_succeeds: true })
    );

    const result = await disableAutoMerge({ ...TARGET });

    expect(result).toEqual({ done: true, replayed: false });
    const { url, init } = lastRequest();
    // The plain update endpoint does not accept the attribute: a PUT there
    // would report success while auto-merge stays armed.
    expect(init.method).toBe('POST');
    expect(url.pathname).toBe(
      `/api/v4/projects/${encodeURIComponent(PROJECT_PATH)}/merge_requests/12/cancel_merge_when_pipeline_succeeds`
    );
    expect(init.body).toBeUndefined();
  });

  it('reports replayed when auto-merge is not armed', async () => {
    const result = await disableAutoMerge({ ...TARGET });

    expect(result).toEqual({ done: true, replayed: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fences a stale head when the caller provides one', async () => {
    mockFetchGitLabMergeRequest.mockResolvedValue(
      openMrFixture('sha-moved', { merge_when_pipeline_succeeds: true })
    );

    await expect(
      disableAutoMerge({ ...TARGET, expectedHeadSha: 'sha-head' })
    ).rejects.toMatchObject({ kind: 'stale_head' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deleteBranch', () => {
  it('deletes the project branch', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const result = await deleteBranch({ ...TARGET, branchName: 'feature/deploy' });

    expect(result).toEqual({ done: true, replayed: false });
    const { url, init } = lastRequest();
    expect(init.method).toBe('DELETE');
    expect(url.pathname).toBe(
      `/api/v4/projects/${encodeURIComponent(PROJECT_PATH)}/repository/branches/${encodeURIComponent('feature/deploy')}`
    );
  });

  it('treats an already-deleted branch as a replay', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: '404 Branch Not Found' }, 404));

    const result = await deleteBranch({ ...TARGET, branchName: 'feature/gone' });

    expect(result).toEqual({ done: true, replayed: true });
  });
});

describe('mutation failures reach the four mobile states', () => {
  it('classifies a 403 approve as non-retryable forbidden and leaks nothing', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: '403 Forbidden — token glpat-secret denied' }, 403)
    );

    const error = await captureRejection(submitReview({ ...TARGET, event: 'approve' }));

    expect(error.kind).toBe('forbidden');
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain('glpat-secret');
    expect(error.message).not.toContain('gitlab.example.com');
  });

  it('classifies a 5xx as retryable', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'boom' }, 502));

    await expect(
      replyToDiscussion({ ...TARGET, discussionId: 'd', body: 'x' })
    ).rejects.toMatchObject({ kind: 'retryable', retryable: true });
  });

  it('classifies a network failure on a provider call as retryable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const error = await captureRejection(
      replyToDiscussion({ ...TARGET, discussionId: 'd', body: 'x' })
    );

    expect(error.kind).toBe('retryable');
    expect(error.retryable).toBe(true);
  });
});
