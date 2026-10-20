import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { createSignedToken } from '@/lib/signed-token';
import {
  getMergeRestrictions,
  getPullRequest,
  getReviewStatus,
  getFileLines,
  listChangedFiles,
  listChecks,
  listDiscussions,
  listInbox,
} from './bitbucket-read';
import { BitbucketReviewError } from './bitbucket-authorization';
import { FILE_LINES_MAX } from '@/lib/github-pr-review/dtos';

const mockGetBitbucketWorkspaceAccessTokenStatus = jest.fn();
const mockReadCachedRepositories = jest.fn();

jest.mock('@/lib/integrations/platforms/bitbucket/workspace-access-token-repository-cache', () => ({
  getBitbucketWorkspaceAccessTokenStatus: (...args: unknown[]) =>
    mockGetBitbucketWorkspaceAccessTokenStatus(...args),
  readCachedBitbucketWorkspaceAccessTokenRepositories: (input: unknown) =>
    mockReadCachedRepositories(input),
}));

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  GIT_TOKEN_SERVICE_API_URL: 'https://token-service.example.com',
  NEXTAUTH_SECRET: 'bitbucket-inbox-test-secret',
}));

jest.mock('@kilocode/web-shared/lib/tokens', () => ({
  generateInternalServiceToken: jest.fn(() => 'svc-mock-token'),
  TOKEN_EXPIRY: { fiveMinutes: 300 },
}));

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  logExceptInTest: () => {},
  warnExceptInTest: () => {},
}));

const ORG_OWNER = {
  type: 'organization' as const,
  organizationId: 'org_1',
  userId: 'user_1',
};

const WORKSPACE = { uuid: '12345678-1234-1234-1234-123456789012', slug: 'acme' };

/** Recorded Bitbucket REST payload shapes (structure, not live data). */
const prDetail = {
  id: 12,
  title: 'Add retry fingerprints',
  state: 'OPEN',
  draft: false,
  summary: { raw: 'Adds collision-free retry fingerprints.' },
  task_count: 1,
  merge_state: 'open',
  author: {
    uuid: '{author-uuid}',
    nickname: 'alice',
    display_name: 'Alice',
    links: { avatar: { href: 'https://bitbucket.org/account/alice/avatar/32' } },
  },
  source: {
    branch: { name: 'feature/retry' },
    commit: { hash: 'abc123def4567890' },
    repository: { full_name: 'acme/repo', uuid: '{repo-uuid}' },
  },
  destination: {
    branch: { name: 'main' },
    commit: { hash: 'bd4567890abcdef12' },
    repository: { full_name: 'acme/repo', uuid: '{repo-uuid}' },
  },
  created_on: '2026-09-01T00:00:00.000000+00:00',
  updated_on: '2026-09-03T00:00:00.000000+00:00',
  links: { html: { href: 'https://bitbucket.org/acme/repo/pull-requests/12' } },
  participants: [
    {
      user: { uuid: '{reviewer-uuid}', nickname: 'bob', display_name: 'Bob' },
      role: 'REVIEWER',
      approved: true,
      state: 'approved',
    },
    {
      user: { uuid: '{author-uuid}', nickname: 'alice', display_name: 'Alice' },
      role: 'PARTICIPANT',
      approved: false,
      state: null,
    },
  ],
};

const diffstatPage1 = {
  pagelen: 2,
  values: [
    {
      status: 'modified',
      lines_added: 3,
      lines_removed: 1,
      old: { path: 'src/retry.ts' },
      new: { path: 'src/retry.ts' },
    },
    {
      status: 'added',
      lines_added: 2,
      lines_removed: 0,
      old: null,
      new: { path: 'src/fingerprint.ts' },
    },
  ],
  next: 'https://api.bitbucket.org/2.0/repositories/acme/repo/pullrequests/12/diffstat?pagelen=2&page=2',
};

const diffstatPage2 = {
  pagelen: 2,
  values: [
    {
      status: 'removed',
      lines_added: 0,
      lines_removed: 4,
      old: { path: 'src/old.ts' },
      new: null,
    },
  ],
};

const commentFixture = {
  pagelen: 50,
  values: [
    {
      id: 101,
      content: { raw: 'General remark' },
      created_on: '2026-09-02T10:00:00.000000+00:00',
      user: { uuid: '{reviewer-uuid}', nickname: 'bob', display_name: 'Bob' },
      deleted: false,
    },
    {
      id: 102,
      parent: { id: 101 },
      content: { raw: 'Reply from the author' },
      created_on: '2026-09-02T11:00:00.000000+00:00',
      user: { uuid: '{author-uuid}', nickname: 'alice', display_name: 'Alice' },
      deleted: false,
    },
    {
      id: 103,
      content: { raw: 'Inline note' },
      inline: { path: 'src/retry.ts', from: null, to: 12 },
      created_on: '2026-09-02T12:00:00.000000+00:00',
      user: { uuid: '{reviewer-uuid}', nickname: 'bob', display_name: 'Bob' },
      deleted: false,
    },
    {
      id: 104,
      content: { raw: 'Deleted comment' },
      deleted: true,
    },
  ],
  next: null,
};

const taskFixture = {
  pagelen: 100,
  values: [
    {
      id: 7,
      resolved_on: null,
      comment: { id: 101 },
    },
  ],
  next: null,
};

const buildStatusesFixture = {
  pagelen: 10,
  values: [
    {
      state: 'SUCCESSFUL',
      key: 'pipeline.build',
      name: 'Build and test',
      url: 'https://bitbucket.org/acme/repo/pipelines/results/1',
      links: { status: { href: 'https://bitbucket.org/acme/repo/pipelines/results/1' } },
    },
    {
      state: 'INPROGRESS',
      key: 'pipeline.deploy',
      name: 'Deploy',
      url: 'https://bitbucket.org/acme/repo/pipelines/results/2',
    },
  ],
  next: null,
};

const branchRestrictionsFixture = {
  pagelen: 10,
  values: [
    { kind: 'require_approvals_to_merge', value: 2 },
    { kind: 'require_passing_builds_to_merge', value: null },
    { kind: 'require_tasks_to_be_completed', value: null },
  ],
  next: null,
};

let fetchMock: jest.Mock;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Await a rejection and return it typed, without a success-branch union. */
async function captureRejection(promise: Promise<unknown>): Promise<BitbucketReviewError> {
  try {
    await promise;
  } catch (reason) {
    return reason as BitbucketReviewError;
  }
  throw new Error('Expected the call to reject.');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBitbucketWorkspaceAccessTokenStatus.mockResolvedValue({
    status: 'connected',
    integrationId: 'intg_1',
    workspace: { ...WORKSPACE, displayName: 'Acme' },
  });
  mockReadCachedRepositories.mockResolvedValue({
    status: 'available',
    repositories: [
      {
        id: '87654321-4321-4321-4321-210987654321',
        workspaceUuid: WORKSPACE.uuid,
        name: 'repo',
        fullName: 'acme/repo',
        private: true,
        defaultBranch: 'main',
      },
    ],
    syncedAt: '2026-09-06T00:00:00.000Z',
  });
  fetchMock = jest.fn();
  fetchMock.mockImplementation(async (url: string | URL) => {
    const full = url.toString();
    const parsed = new URL(full);
    if (full.includes('token-service.example.com')) {
      return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
    }
    if (parsed.pathname.endsWith('/pullrequests/12/diffstat')) {
      return parsed.searchParams.get('page') === '2'
        ? jsonResponse(diffstatPage2)
        : jsonResponse(diffstatPage1);
    }
    if (parsed.pathname.endsWith('/pullrequests/12/comments')) return jsonResponse(commentFixture);
    if (parsed.pathname.endsWith('/pullrequests/12/tasks')) return jsonResponse(taskFixture);
    if (parsed.pathname.endsWith('/commit/abc123def4567890/statuses')) {
      return jsonResponse(buildStatusesFixture);
    }
    if (parsed.pathname.endsWith('/branch-restrictions')) {
      return jsonResponse(branchRestrictionsFixture);
    }
    if (parsed.pathname.endsWith('/pullrequests/12')) return jsonResponse(prDetail);
    if (parsed.pathname.includes('/src/')) {
      return new Response('line one\nline two\nline three', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return jsonResponse({ pagelen: 50, values: [], next: null });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getPullRequest', () => {
  it('maps the recorded detail into the s1 summary with source.commit.hash as headSha', async () => {
    const summary = await getPullRequest(ORG_OWNER, 'acme', 'repo', 12);

    expect(summary.ref).toEqual({
      platform: 'bitbucket',
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
    });
    expect(summary).toMatchObject({
      title: 'Add retry fingerprints',
      body: 'Adds collision-free retry fingerprints.',
      author: { login: 'alice', avatarUrl: 'https://bitbucket.org/account/alice/avatar/32' },
      state: 'open',
      draft: false,
      headRef: 'feature/retry',
      baseRef: 'main',
      headSha: 'abc123def4567890',
      changedFiles: 3,
      additions: 5,
      deletions: 5,
      webUrl: 'https://bitbucket.org/acme/repo/pull-requests/12',
    });
  });

  it('maps MERGED and DECLINED provider states onto the shared lifecycle', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      if (new URL(full).pathname.endsWith('/pullrequests/12')) {
        return jsonResponse({ ...prDetail, state: 'MERGED' });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const summary = await getPullRequest(ORG_OWNER, 'acme', 'repo', 12);

    expect(summary.state).toBe('merged');
  });

  it('follows a same-origin 302 the diffstat endpoint answers with', async () => {
    const redirectTarget =
      'https://api.bitbucket.org/2.0/repositories/acme/repo/diffstat/acme/repo:abc%0Ddef?pagelen=50&from_pullrequest_id=12&topic=true';
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      if (new URL(full).pathname.endsWith('/pullrequests/12')) {
        return jsonResponse(prDetail);
      }
      if (full === redirectTarget) {
        return jsonResponse(diffstatPage1);
      }
      if (new URL(full).pathname.endsWith('/pullrequests/12/diffstat')) {
        return new Response(null, {
          status: 302,
          headers: { location: redirectTarget },
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await listChangedFiles(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.files).toHaveLength(diffstatPage1.values.length);
    expect(fetchMock).toHaveBeenCalledWith(redirectTarget, expect.anything());
  });

  it('raises the bare status for a redirect that leaves the Bitbucket API origin', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      if (new URL(full).pathname.endsWith('/pullrequests/12')) {
        return jsonResponse(prDetail);
      }
      if (new URL(full).pathname.endsWith('/pullrequests/12/diffstat')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.com/2.0/steal' },
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const error = await captureRejection(listChangedFiles(ORG_OWNER, 'acme', 'repo', 12));

    expect(error.kind).toBe('retryable');
    expect(error.message).toBe('Bitbucket returned an unexpected error.');
  });
});

describe('listChangedFiles — pagination', () => {
  it('maps diffstat entries into the shared file DTO', async () => {
    const result = await listChangedFiles(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({
      path: 'src/retry.ts',
      previousPath: null,
      status: 'modified',
      additions: 3,
      deletions: 1,
    });
    expect(result.files[1]).toMatchObject({ path: 'src/fingerprint.ts', status: 'added' });
    expect(result.nextCursor).not.toBeNull();
  });

  it('follows the encoded provider next URL with a fresh token on page 2', async () => {
    const page1 = await listChangedFiles(ORG_OWNER, 'acme', 'repo', 12);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listChangedFiles(ORG_OWNER, 'acme', 'repo', 12, page1.nextCursor ?? '');

    expect(page2.files).toHaveLength(1);
    expect(page2.files[0]).toMatchObject({
      path: 'src/old.ts',
      status: 'removed',
      deletions: 4,
    });
    expect(page2.nextCursor).toBeNull();
    // The last request carried the provider next URL against the fixed origin.
    const last = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0] as string;
    expect(last).toContain('api.bitbucket.org/2.0/repositories/acme/repo/pullrequests/12/diffstat');
    expect(last).toContain('page=2');
  });

  it('ignores a cursor minted for another repository identity (reads page 1)', async () => {
    const otherPr = await listChangedFiles(ORG_OWNER, 'acme', 'repo', 12);
    expect(otherPr.nextCursor).not.toBeNull();

    // A cursor for PR 12 is used against PR 13: the identity check fails and
    // the request restarts from page 1 of PR 13's diffstat.
    const result = await listChangedFiles(ORG_OWNER, 'acme', 'repo', 13, otherPr.nextCursor ?? '');
    const last = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0] as string;
    expect(last).toContain('/pullrequests/13/diffstat');
    expect(last).not.toContain('page=2');
    expect(result.nextCursor).toBeNull();
  });

  it('ends pagination on a provider next link outside the guarded repository path', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      if (new URL(full).pathname.endsWith('/pullrequests/12/diffstat')) {
        return jsonResponse({
          pagelen: 1,
          values: [
            {
              status: 'modified',
              lines_added: 1,
              lines_removed: 0,
              old: null,
              new: { path: 'src/x.ts' },
            },
          ],
          next: 'https://evil.example.com/2.0/repositories/acme/repo/pullrequests/12/diffstat?page=2',
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await listChangedFiles(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.files).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });
});

describe('getFileLines', () => {
  it('returns the 1-based inclusive line window of the file at the commit', async () => {
    const result = await getFileLines(
      ORG_OWNER,
      'acme',
      'repo',
      'abc123def4567890',
      'src/retry.ts',
      2,
      3
    );

    expect(result.lines).toEqual(['line two', 'line three']);
    expect(result.totalLines).toBe(3);
  });

  it('refuses a non-commit ref before any Bitbucket API request', async () => {
    await expect(
      getFileLines(ORG_OWNER, 'acme', 'repo', '../../etc/passwd', 'src/retry.ts', 1, 2)
    ).rejects.toMatchObject({ kind: 'bad_request' });
    // Only the credential release may have run; no provider request was made.
    expect(
      fetchMock.mock.calls.filter(call => String(call[0]).includes('api.bitbucket.org'))
    ).toEqual([]);
  });

  it('maps a provider 404 to non-retryable not_found', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      if (full.includes('/src/')) return new Response(null, { status: 404 });
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const error = await captureRejection(
      getFileLines(ORG_OWNER, 'acme', 'repo', 'abc123def4567890', 'src/missing.ts', 1, 2)
    );

    expect(error).toBeInstanceOf(BitbucketReviewError);
    expect(error.kind).toBe('not_found');
    expect(error.retryable).toBe(false);
  });

  it('caps the returned window at the shared FILE_LINES_MAX', async () => {
    // 600 lines is well past the cap: the returned slice must stop at the
    // shared limit instead of handing back the whole file as context.
    const content = Array.from({ length: 600 }, (_, index) => `line ${index + 1}`).join('\n');
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      if (full.includes('/src/')) {
        return new Response(content, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await getFileLines(
      ORG_OWNER,
      'acme',
      'repo',
      'abc123def4567890',
      'src/retry.ts',
      1,
      600
    );

    expect(result.totalLines).toBe(600);
    expect(result.lines).toHaveLength(FILE_LINES_MAX);
    expect(result.lines[0]).toBe('line 1');
    expect(result.lines.at(-1)).toBe(`line ${FILE_LINES_MAX}`);
  });
});

describe('listDiscussions', () => {
  it('builds general and inline threads with replies and task-based resolution', async () => {
    const result = await listDiscussions(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.threads).toHaveLength(2);

    const general = result.threads[0];
    expect(general).toMatchObject({
      threadId: '101',
      resolved: false,
      path: null,
      line: null,
      side: null,
      taskCount: 1,
    });
    expect(general.comments.map(comment => comment.body)).toEqual([
      'General remark',
      'Reply from the author',
    ]);

    const inline = result.threads[1];
    expect(inline).toMatchObject({
      threadId: '103',
      path: 'src/retry.ts',
      line: 12,
      side: 'RIGHT',
      resolved: false,
      taskCount: 0,
    });
  });

  it('marks a thread resolved when its only task is resolved', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const pathname = new URL(full).pathname;
      if (pathname.endsWith('/pullrequests/12/comments')) return jsonResponse(commentFixture);
      if (pathname.endsWith('/pullrequests/12/tasks')) {
        return jsonResponse({
          pagelen: 100,
          values: [
            { id: 7, resolved_on: '2026-09-04T00:00:00.000000+00:00', comment: { id: 101 } },
          ],
          next: null,
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await listDiscussions(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.threads[0]).toMatchObject({ threadId: '101', resolved: true });
  });

  it('derives taskCount from the collected tasks and keeps a partially resolved thread unresolved', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const pathname = new URL(full).pathname;
      if (pathname.endsWith('/pullrequests/12/comments')) return jsonResponse(commentFixture);
      if (pathname.endsWith('/pullrequests/12/tasks')) {
        return jsonResponse({
          pagelen: 100,
          values: [
            { id: 7, resolved_on: '2026-09-04T00:00:00.000000+00:00', comment: { id: 101 } },
            { id: 8, resolved_on: null, comment: { id: 101 } },
            { id: 9, resolved_on: null, comment: { id: 103 } },
          ],
          next: null,
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await listDiscussions(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.threads[0]).toMatchObject({ threadId: '101', resolved: false, taskCount: 2 });
    expect(result.threads[1]).toMatchObject({ threadId: '103', resolved: false, taskCount: 1 });
  });

  it('keeps threads unreadable-to-resolve when the task collection is not exposed', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const pathname = new URL(full).pathname;
      if (pathname.endsWith('/pullrequests/12/comments')) return jsonResponse(commentFixture);
      if (pathname.endsWith('/pullrequests/12/tasks')) return new Response(null, { status: 404 });
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await listDiscussions(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.threads).toHaveLength(2);
    expect(result.threads.every(thread => thread.resolved === false)).toBe(true);
  });

  it('keeps a thread unresolved when an unresolved task sits on a later task page', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const parsed = new URL(full);
      if (parsed.pathname.endsWith('/pullrequests/12/comments'))
        return jsonResponse(commentFixture);
      if (parsed.pathname.endsWith('/pullrequests/12/tasks')) {
        // Page 1 holds a resolved task for comment 101, page 2 an unresolved
        // one: reading only page 1 would claim a resolution the full
        // collection contradicts.
        return parsed.searchParams.get('page') === '2'
          ? jsonResponse({
              pagelen: 100,
              values: [{ id: 8, resolved_on: null, comment: { id: 101 } }],
              next: null,
            })
          : jsonResponse({
              pagelen: 100,
              values: [
                { id: 7, resolved_on: '2026-09-04T00:00:00.000000+00:00', comment: { id: 101 } },
              ],
              next: 'https://api.bitbucket.org/2.0/repositories/acme/repo/pullrequests/12/tasks?pagelen=100&page=2',
            });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await listDiscussions(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.threads[0]).toMatchObject({ threadId: '101', resolved: false, taskCount: 2 });
    // The collection was followed to page 2 before the evidence was folded.
    expect(
      fetchMock.mock.calls.filter(call =>
        new URL(String(call[0])).pathname.endsWith('/pullrequests/12/tasks')
      )
    ).toHaveLength(2);
  });

  it('reports no task evidence when the task collection exceeds the page bound', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const parsed = new URL(full);
      if (parsed.pathname.endsWith('/pullrequests/12/comments'))
        return jsonResponse(commentFixture);
      if (parsed.pathname.endsWith('/pullrequests/12/tasks')) {
        // Every page resolves comment 101 and points at a further page: past
        // the walk bound the evidence is unverified, so it must not claim a
        // resolution the unread pages could contradict.
        const pageIndex = Number(parsed.searchParams.get('page') ?? '1');
        return jsonResponse({
          pagelen: 100,
          values: [
            {
              id: 100 + pageIndex,
              resolved_on: '2026-09-04T00:00:00.000000+00:00',
              comment: { id: 101 },
            },
          ],
          next: `https://api.bitbucket.org/2.0/repositories/acme/repo/pullrequests/12/tasks?pagelen=100&page=${pageIndex + 1}`,
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await listDiscussions(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.threads[0]).toMatchObject({ threadId: '101', resolved: false, taskCount: 0 });
    expect(result.threads[1]).toMatchObject({ threadId: '103', resolved: false, taskCount: 0 });
    // The walk stops at the bound instead of crawling an unbounded collection.
    expect(
      fetchMock.mock.calls.filter(call =>
        new URL(String(call[0])).pathname.endsWith('/pullrequests/12/tasks')
      )
    ).toHaveLength(10);
  });

  it('degrades to no task evidence when a followed task page answers 404', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const parsed = new URL(full);
      if (parsed.pathname.endsWith('/pullrequests/12/comments'))
        return jsonResponse(commentFixture);
      if (parsed.pathname.endsWith('/pullrequests/12/tasks')) {
        // Page 1 resolves comment 101 and points at page 2, and the followed
        // page is unreadable. The documented degradation (an unreadable task
        // collection leaves no evidence) must apply on a cursor-followed page
        // too, not only on the first.
        if (parsed.searchParams.get('page') === '2') return new Response(null, { status: 404 });
        return jsonResponse({
          pagelen: 100,
          values: [
            { id: 7, resolved_on: '2026-09-04T00:00:00.000000+00:00', comment: { id: 101 } },
          ],
          next: 'https://api.bitbucket.org/2.0/repositories/acme/repo/pullrequests/12/tasks?pagelen=100&page=2',
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await listDiscussions(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.threads).toHaveLength(2);
    expect(result.threads.every(thread => thread.resolved === false)).toBe(true);
    expect(result.threads.every(thread => thread.taskCount === 0)).toBe(true);
  });

  it('surfaces a reply whose root sits on an earlier comments page', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const parsed = new URL(full);
      if (parsed.pathname.endsWith('/pullrequests/12/comments')) {
        // The page starts on a reply: its root (900) was served by the
        // previous comments page and is not present in this page.
        return jsonResponse({
          pagelen: 50,
          values: [
            {
              id: 901,
              parent: { id: 900 },
              content: { raw: 'Reply on a root from the previous page' },
              created_on: '2026-09-02T13:00:00.000000+00:00',
              user: { uuid: '{author-uuid}', nickname: 'alice', display_name: 'Alice' },
              deleted: false,
            },
            {
              id: 902,
              content: { raw: 'Second page root' },
              created_on: '2026-09-02T14:00:00.000000+00:00',
              user: { uuid: '{reviewer-uuid}', nickname: 'bob', display_name: 'Bob' },
              deleted: false,
            },
          ],
          next: null,
        });
      }
      if (parsed.pathname.endsWith('/pullrequests/12/tasks'))
        return jsonResponse({ pagelen: 100, values: [], next: null });
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await listDiscussions(ORG_OWNER, 'acme', 'repo', 12);

    // The orphan reply is keyed `root:firstReplyId` — namespaced so it cannot
    // repeat the root thread's id the previous page served — and the root id
    // still leads the id, so a resolve action still targets the root it
    // belongs to.
    const orphan = result.threads.find(thread => thread.threadId === '900:901');
    expect(orphan?.comments.map(comment => comment.body)).toEqual([
      'Reply on a root from the previous page',
    ]);
    const secondRoot = result.threads.find(thread => thread.threadId === '902');
    expect(secondRoot?.comments.map(comment => comment.body)).toEqual(['Second page root']);
    // Every comment on the page is surfaced exactly once.
    const bodies = result.threads
      .flatMap(thread => thread.comments.map(comment => comment.body))
      .sort();
    expect(bodies).toEqual(['Reply on a root from the previous page', 'Second page root']);
  });

  it('never repeats a root thread id on a later comments page', async () => {
    // Root 900 is served on comments page 1; its reply 901 spills onto page
    // 2 (the flat collection is creation-ordered). The continuation page must
    // not emit a thread keyed by the bare root id: consumers key rows and
    // per-thread state by threadId across the whole paginated collection.
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const parsed = new URL(full);
      if (parsed.pathname.endsWith('/pullrequests/12/comments')) {
        if (parsed.searchParams.get('page') === '2') {
          return jsonResponse({
            pagelen: 50,
            values: [
              {
                id: 901,
                parent: { id: 900 },
                content: { raw: 'Reply continuing the split thread' },
                created_on: '2026-09-02T13:00:00.000000+00:00',
                user: { uuid: '{author-uuid}', nickname: 'alice', display_name: 'Alice' },
                deleted: false,
              },
            ],
            next: null,
          });
        }
        return jsonResponse({
          pagelen: 50,
          values: [
            {
              id: 900,
              content: { raw: 'Root of the split thread' },
              created_on: '2026-09-02T12:00:00.000000+00:00',
              user: { uuid: '{reviewer-uuid}', nickname: 'bob', display_name: 'Bob' },
              deleted: false,
            },
          ],
          next: 'https://api.bitbucket.org/2.0/repositories/acme/repo/pullrequests/12/comments?pagelen=50&page=2',
        });
      }
      if (parsed.pathname.endsWith('/pullrequests/12/tasks'))
        return jsonResponse({ pagelen: 100, values: [], next: null });
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const firstPage = await listDiscussions(ORG_OWNER, 'acme', 'repo', 12);
    expect(firstPage.threads.map(thread => thread.threadId)).toEqual(['900']);

    const secondPage = await listDiscussions(
      ORG_OWNER,
      'acme',
      'repo',
      12,
      firstPage.nextCursor ?? undefined
    );
    const pageIds = [...firstPage.threads, ...secondPage.threads].map(thread => thread.threadId);
    // The fragment keeps its own identity (root:firstReplyId) and never
    // repeats the root thread's id, while still carrying the root id for
    // thread actions.
    expect(new Set(pageIds).size).toBe(pageIds.length);
    expect(secondPage.threads.map(thread => thread.threadId)).toEqual(['900:901']);
  });
});

describe('listChecks', () => {
  it('maps commit build statuses onto the shared checks DTO', async () => {
    const result = await listChecks(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.checks).toEqual([
      {
        name: 'Build and test',
        status: 'completed',
        conclusion: 'success',
        detailsUrl: 'https://bitbucket.org/acme/repo/pipelines/results/1',
      },
      {
        name: 'Deploy',
        status: 'pending',
        conclusion: null,
        detailsUrl: 'https://bitbucket.org/acme/repo/pipelines/results/2',
      },
    ]);
  });

  it('maps a failed build to conclusion failed', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const pathname = new URL(full).pathname;
      if (pathname.endsWith('/pullrequests/12')) return jsonResponse(prDetail);
      if (pathname.endsWith('/statuses')) {
        return jsonResponse({
          pagelen: 10,
          values: [{ state: 'FAILED', key: 'pipeline.build', name: 'Build and test', url: null }],
          next: null,
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await listChecks(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.checks[0]).toMatchObject({ status: 'completed', conclusion: 'failed' });
  });

  it('returns no checks when the PR has no source commit', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      if (new URL(full).pathname.endsWith('/pullrequests/12')) {
        return jsonResponse({
          ...prDetail,
          source: { branch: { name: 'feature/retry' }, commit: null },
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await listChecks(ORG_OWNER, 'acme', 'repo', 12);

    expect(result.checks).toEqual([]);
  });
});

describe('listInbox', () => {
  const inboxPr = (id: number, updatedOn: string, fullName = 'acme/repo') => ({
    id,
    title: `PR ${id}`,
    state: 'OPEN',
    draft: false,
    author: { uuid: '{author-uuid}', nickname: 'alice', display_name: 'Alice' },
    updated_on: updatedOn,
    source: { branch: { name: 'feature/retry' }, repository: { full_name: fullName } },
    destination: { branch: { name: 'main' }, repository: { full_name: fullName } },
  });

  type InboxRow = { updated_on: string };
  type InboxRequest = { slug: string; query: string | null; page: string | null };

  /**
   * The workspace inbox as the provider serves it: each repository answers
   * with its rows at or below the requested boundary, newest first, one page.
   */
  const serveInbox = (rowsBySlug: Record<string, InboxRow[]>, requests: InboxRequest[]) => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const parsed = new URL(full);
      if (parsed.pathname === '/2.0/repositories/acme') {
        return jsonResponse({
          pagelen: 100,
          values: Object.keys(rowsBySlug).map(slug => ({ slug })),
          next: null,
        });
      }
      const match = parsed.pathname.match(/^\/2\.0\/repositories\/acme\/([^/]+)\/pullrequests$/);
      const rows = match ? rowsBySlug[match[1]] : undefined;
      if (!match || !rows) return jsonResponse({ pagelen: 50, values: [], next: null });
      const query = parsed.searchParams.get('q');
      requests.push({ slug: match[1], query, page: parsed.searchParams.get('page') });
      const boundary = query?.match(/^state="OPEN" AND updated_on <= (.+)$/);
      const boundaryMs = boundary ? Date.parse(boundary[1]) : null;
      const eligible = rows
        .filter(row => boundaryMs === null || Date.parse(row.updated_on) <= boundaryMs)
        .sort((left, right) => Date.parse(right.updated_on) - Date.parse(left.updated_on));
      return jsonResponse({
        pagelen: 50,
        values: eligible.slice(0, 50),
        next: eligible.length > 50 ? 'https://api.bitbucket.org/2.0/next?page=2' : null,
      });
    });
  };

  const minutesFixture = (firstId: number, count: number) =>
    Array.from({ length: count }, (_, index) =>
      inboxPr(firstId + index, `2026-09-02T00:${String(index).padStart(2, '0')}:00+00:00`)
    );

  it('fans out over the workspace repositories and carries full identity', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const parsed = new URL(full);
      if (parsed.pathname === '/2.0/repositories/acme') {
        return jsonResponse({
          pagelen: 100,
          values: [{ slug: 'repo' }, { slug: 'empty-repo' }],
          next: null,
        });
      }
      if (parsed.pathname === '/2.0/repositories/acme/repo/pullrequests') {
        expect(parsed.searchParams.get('q')).toBe('state="OPEN"');
        // The provider listing is pinned to the inbox's own sort key, so the
        // merged windows continue each other across pages.
        expect(parsed.searchParams.get('sort')).toBe('-updated_on');
        return jsonResponse({
          pagelen: 50,
          values: [
            inboxPr(12, '2026-09-02T00:00:00.000000+00:00'),
            {
              id: 13,
              title: 'Foreign workspace PR',
              state: 'OPEN',
              draft: false,
              updated_on: '2026-09-03T00:00:00.000000+00:00',
              destination: { repository: { full_name: 'other-ws/other-repo' } },
            },
            {
              id: 14,
              title: 'No repository identity',
              state: 'OPEN',
              draft: false,
              updated_on: null,
            },
          ],
          next: null,
        });
      }
      if (parsed.pathname === '/2.0/repositories/acme/empty-repo/pullrequests') {
        return jsonResponse({ pagelen: 50, values: [], next: null });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await listInbox(ORG_OWNER);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      ref: { platform: 'bitbucket', workspace: 'acme', repoSlug: 'repo', prId: 12 },
      title: 'PR 12',
      author: { login: 'alice' },
      state: 'open',
      draft: false,
    });
    expect(result.nextCursor).toBeNull();
  });

  it('continues one repository from the signed boundary', async () => {
    // 60 open PRs: the first load serves the newest 50 and hands back a signed
    // boundary; the next load asks only for rows at or below that boundary.
    const requests: InboxRequest[] = [];
    serveInbox({ repo: minutesFixture(100, 60) }, requests);

    const first = await listInbox(ORG_OWNER);
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.ref).toMatchObject({ prId: 159 });
    expect(first.nextCursor).toBeTruthy();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ slug: 'repo', query: 'state="OPEN"', page: '1' });

    const second = await listInbox(ORG_OWNER, first.nextCursor!);
    // One provider page for the continuation too, carrying the boundary of
    // the last row already served.
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      slug: 'repo',
      query: 'state="OPEN" AND updated_on <= 2026-09-02T00:10:00.000+00:00',
      page: '1',
    });
    expect(second.items).toHaveLength(10);
    expect(second.items[0]?.ref).toMatchObject({ prId: 109 });
    expect(second.nextCursor).toBeNull();

    const served = [...first.items, ...second.items].flatMap(item =>
      item.ref && 'prId' in item.ref ? [item.ref.prId] : []
    );
    expect(new Set(served).size).toBe(60);
  });

  it('continues several repositories across pages', async () => {
    // repo-a's rows are all older than repo-b's, so the first load serves
    // exactly repo-b's page and the continuation serves repo-a's.
    const requests: InboxRequest[] = [];
    serveInbox(
      {
        'repo-a': minutesFixture(100, 50),
        'repo-b': Array.from({ length: 50 }, (_, index) =>
          inboxPr(200 + index, `2026-09-02T01:${String(index).padStart(2, '0')}:00+00:00`)
        ),
      },
      requests
    );

    const first = await listInbox(ORG_OWNER);
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.ref).toMatchObject({ prId: 249 });
    expect(first.nextCursor).toBeTruthy();

    const second = await listInbox(ORG_OWNER, first.nextCursor!);
    expect(second.items).toHaveLength(50);
    expect(second.items[0]?.ref).toMatchObject({ prId: 149 });
    expect(second.nextCursor).toBeNull();
    expect(requests).toHaveLength(4);

    const served = [...first.items, ...second.items].flatMap(item =>
      item.ref && 'prId' in item.ref ? [item.ref.prId] : []
    );
    expect(new Set(served).size).toBe(100);
  });

  it('reads one provider page per repository on every inbox page', async () => {
    // 12 repositories × 5 open PRs: every load reads one page per repository.
    const rowsBySlug: Record<string, InboxRow[]> = {};
    for (let repo = 0; repo < 12; repo += 1) {
      rowsBySlug[`repo-${repo}`] = Array.from({ length: 5 }, (_, index) =>
        inboxPr(
          1000 + repo * 10 + index,
          `2026-09-02T00:${String(repo * 5 + index).padStart(2, '0')}:00+00:00`
        )
      );
    }
    const requests: InboxRequest[] = [];
    serveInbox(rowsBySlug, requests);

    const first = await listInbox(ORG_OWNER);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    expect(requests).toHaveLength(12);

    const second = await listInbox(ORG_OWNER, first.nextCursor!);
    expect(requests).toHaveLength(24);
    expect(second.items).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
    expect(requests.every(request => request.page === '1')).toBe(true);
    expect(requests.filter(request => request.query === 'state="OPEN"')).toHaveLength(12);
  });

  it('reads one provider page per enumerated repository', async () => {
    // The enumeration cap is 300 repositories; a load reads at most one page
    // from each of them.
    const rowsBySlug: Record<string, InboxRow[]> = {};
    for (let repo = 0; repo < 300; repo += 1) {
      rowsBySlug[`repo-${repo}`] = [
        inboxPr(repo, `2026-09-02T00:${String(repo % 60).padStart(2, '0')}:00+00:00`),
      ];
    }
    const requests: InboxRequest[] = [];
    serveInbox(rowsBySlug, requests);

    const page = await listInbox(ORG_OWNER);
    expect(requests).toHaveLength(300);
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBeTruthy();
  });

  it('starts again at the first page when continuation state is not valid', async () => {
    const requests: InboxRequest[] = [];
    serveInbox({ repo: minutesFixture(100, 60) }, requests);

    const clientValue = Buffer.from(
      JSON.stringify({ identity: 'bitbucket-inbox:acme', page: 10 })
    ).toString('base64url');
    const page = await listInbox(ORG_OWNER, clientValue);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ query: 'state="OPEN"', page: '1' });
    expect(page.items).toHaveLength(50);
  });

  it('scopes continuation state to the workspace it was issued for', async () => {
    const requests: InboxRequest[] = [];
    serveInbox({ repo: minutesFixture(100, 60) }, requests);

    const foreign = createSignedToken({
      kind: 'bitbucket-inbox-cursor',
      identity: 'bitbucket-inbox:evil',
      boundary: '2026-09-02T00:10:00.000+00:00',
      servedRefs: [],
    });
    const page = await listInbox(ORG_OWNER, foreign);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ query: 'state="OPEN"' });
    expect(page.items).toHaveLength(50);
  });

  it('accepts continuation state only with a matching signature', async () => {
    const requests: InboxRequest[] = [];
    serveInbox({ repo: minutesFixture(100, 60) }, requests);
    const first = await listInbox(ORG_OWNER);
    const cursor = first.nextCursor!;
    requests.length = 0;

    const invalidSignature = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
    await listInbox(ORG_OWNER, invalidSignature);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ query: 'state="OPEN"', page: '1' });
  });

  it('keeps continuation state usable for one hour', async () => {
    const requests: InboxRequest[] = [];
    serveInbox({ repo: minutesFixture(100, 60) }, requests);

    const encoded = Buffer.from(
      JSON.stringify({
        kind: 'bitbucket-inbox-cursor',
        identity: 'bitbucket-inbox:acme',
        boundary: '2026-09-02T00:10:00.000+00:00',
        servedRefs: [],
        iat: Math.floor(Date.now() / 1000) - 2 * 60 * 60,
        nonce: 'expired-nonce',
      })
    ).toString('base64url');
    const signature = crypto
      .createHmac('sha256', NEXTAUTH_SECRET)
      .update(encoded)
      .digest('base64url');
    const page = await listInbox(ORG_OWNER, `${encoded}.${signature}`);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ query: 'state="OPEN"' });
    expect(page.items).toHaveLength(50);
  });
});

describe('getMergeRestrictions', () => {
  it('derives the merge gate from draft state, tasks, approvals, and merge checks', async () => {
    const state = await getMergeRestrictions(ORG_OWNER, 'acme', 'repo', 12);

    expect(state).toMatchObject({
      canMerge: false,
      approvalsRequired: 2,
      pipelineMustSucceed: true,
      conflicts: false,
    });
    const codes = state.blockedReasons.map(reason => reason.code);
    expect(codes).toContain('required_approvals');
    expect(codes).toContain('pending_pipeline');
    // One approved reviewer against a requirement of two: one approval left.
    expect(state.blockedReasons).toContainEqual({
      code: 'required_approvals',
      message: '1 more approval required.',
    });
  });

  it('reads mergeable when the PR is open, reviewed, and its checks pass', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const pathname = new URL(full).pathname;
      if (pathname.endsWith('/pullrequests/12')) {
        return jsonResponse({ ...prDetail, task_count: 0 });
      }
      if (pathname.endsWith('/statuses')) {
        return jsonResponse({
          pagelen: 10,
          values: [{ state: 'SUCCESSFUL', key: 'pipeline.build', name: 'Build', url: null }],
          next: null,
        });
      }
      if (pathname.endsWith('/branch-restrictions')) {
        return jsonResponse({
          pagelen: 10,
          values: [
            { kind: 'require_approvals_to_merge', value: 1 },
            { kind: 'require_passing_builds_to_merge', value: null },
          ],
          next: null,
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const state = await getMergeRestrictions(ORG_OWNER, 'acme', 'repo', 12);

    expect(state.canMerge).toBe(true);
    expect(state.blockedReasons).toEqual([]);
  });

  it('blocks a draft pull request with the provider wording', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const pathname = new URL(full).pathname;
      if (pathname.endsWith('/pullrequests/12')) {
        return jsonResponse({ ...prDetail, draft: true, task_count: 0 });
      }
      return jsonResponse({ pagelen: 10, values: [], next: null });
    });

    const state = await getMergeRestrictions(ORG_OWNER, 'acme', 'repo', 12);

    expect(state.blockedReasons).toContainEqual({
      code: 'draft',
      message: 'The pull request is still a draft.',
    });
  });

  it('reports a conflicted pull request from the file-conflicts endpoint', async () => {
    const conflictSpecs: string[] = [];
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const pathname = new URL(full).pathname;
      if (pathname.endsWith('/pullrequests/12')) {
        return jsonResponse({ ...prDetail, task_count: 0 });
      }
      // The provider's conflict verdict: one page over the PR's
      // source..destination commit range.
      const conflictsMatch = pathname.match(/\/file-conflicts\/([0-9a-f]+\.\.[0-9a-f]+)$/);
      if (conflictsMatch) {
        conflictSpecs.push(decodeURIComponent(conflictsMatch[1]));
        return jsonResponse({
          pagelen: 100,
          values: [
            {
              type: 'conflict',
              path: 'src/retry.ts',
              scenario: 'content',
              message: 'File modified in both source and destination',
            },
          ],
          next: null,
        });
      }
      if (pathname.endsWith('/statuses')) {
        return jsonResponse({
          pagelen: 10,
          values: [{ state: 'SUCCESSFUL', key: 'pipeline.build', name: 'Build', url: null }],
          next: null,
        });
      }
      return jsonResponse({ pagelen: 10, values: [], next: null });
    });

    const state = await getMergeRestrictions(ORG_OWNER, 'acme', 'repo', 12);

    // The range spec is the PR's own source and destination commits.
    expect(conflictSpecs).toEqual(['abc123def4567890..bd4567890abcdef12']);
    expect(state.conflicts).toBe(true);
    expect(state.blockedReasons).toContainEqual({
      code: 'conflicts',
      message: 'The pull request has conflicts that must be resolved.',
    });
    expect(state.canMerge).toBe(false);
  });

  it('reports a conflicted pull request from the provider merge_state', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const pathname = new URL(full).pathname;
      if (pathname.endsWith('/pullrequests/12')) {
        return jsonResponse({ ...prDetail, merge_state: 'UNCLEAN', task_count: 0 });
      }
      if (pathname.endsWith('/statuses')) {
        return jsonResponse({
          pagelen: 10,
          values: [{ state: 'SUCCESSFUL', key: 'pipeline.build', name: 'Build', url: null }],
          next: null,
        });
      }
      return jsonResponse({ pagelen: 10, values: [], next: null });
    });

    const state = await getMergeRestrictions(ORG_OWNER, 'acme', 'repo', 12);

    expect(state.conflicts).toBe(true);
    expect(state.blockedReasons).toContainEqual({
      code: 'conflicts',
      message: 'The pull request has conflicts that must be resolved.',
    });
    expect(state.canMerge).toBe(false);
  });

  it('reports no conflict when the file-conflicts endpoint answers an empty page', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const pathname = new URL(full).pathname;
      if (pathname.endsWith('/pullrequests/12')) {
        return jsonResponse({ ...prDetail, task_count: 0 });
      }
      if (pathname.includes('/file-conflicts/')) {
        return jsonResponse({ pagelen: 100, values: [], next: null });
      }
      if (pathname.endsWith('/statuses')) {
        return jsonResponse({
          pagelen: 10,
          values: [{ state: 'SUCCESSFUL', key: 'pipeline.build', name: 'Build', url: null }],
          next: null,
        });
      }
      return jsonResponse({ pagelen: 10, values: [], next: null });
    });

    const state = await getMergeRestrictions(ORG_OWNER, 'acme', 'repo', 12);

    expect(state.conflicts).toBe(false);
  });

  it('keeps merging possible when the file-conflicts endpoint is unreadable', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      const pathname = new URL(full).pathname;
      if (pathname.endsWith('/pullrequests/12')) {
        return jsonResponse({ ...prDetail, task_count: 0 });
      }
      if (pathname.includes('/file-conflicts/')) {
        return new Response(null, { status: 403 });
      }
      if (pathname.endsWith('/statuses')) {
        return jsonResponse({
          pagelen: 10,
          values: [{ state: 'SUCCESSFUL', key: 'pipeline.build', name: 'Build', url: null }],
          next: null,
        });
      }
      if (pathname.endsWith('/branch-restrictions')) {
        return jsonResponse({
          pagelen: 10,
          values: [{ kind: 'require_approvals_to_merge', value: 1 }],
          next: null,
        });
      }
      return jsonResponse({ pagelen: 10, values: [], next: null });
    });

    const state = await getMergeRestrictions(ORG_OWNER, 'acme', 'repo', 12);

    expect(state.conflicts).toBe(false);
    // The unreadable conflict surface must not turn into a bogus block.
    expect(state.canMerge).toBe(true);
  });

  it('blocks merge on unresolved tasks even when the restriction list is unreadable', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      if (new URL(full).pathname.endsWith('/branch-restrictions')) {
        return new Response(null, { status: 403 });
      }
      return jsonResponse({ ...prDetail, task_count: 2 });
    });

    const state = await getMergeRestrictions(ORG_OWNER, 'acme', 'repo', 12);

    expect(state.blockedReasons).toContainEqual({
      code: 'other',
      message: 'Resolve all tasks before merging.',
    });
    expect(state.canMerge).toBe(false);
  });

  it('treats unreadable branch restrictions as no visible merge gate', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      if (new URL(full).pathname.endsWith('/branch-restrictions')) {
        return new Response(null, { status: 403 });
      }
      return jsonResponse({ ...prDetail, task_count: 0 });
    });

    const state = await getMergeRestrictions(ORG_OWNER, 'acme', 'repo', 12);

    expect(state.approvalsRequired).toBe(0);
    expect(state.pipelineMustSucceed).toBe(false);
  });
});

describe('getReviewStatus', () => {
  it('returns participants with approval state and REVIEWER role', async () => {
    const status = await getReviewStatus(ORG_OWNER, 'acme', 'repo', 12);

    expect(status.participants).toEqual([
      {
        login: 'bob',
        avatarUrl: null,
        approved: true,
        reviewer: true,
      },
      {
        login: 'alice',
        avatarUrl: null,
        approved: false,
        reviewer: false,
      },
    ]);
  });

  it('carries the avatar link when the provider supplies one', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE });
      }
      if (new URL(full).pathname.endsWith('/pullrequests/12')) {
        return jsonResponse({
          ...prDetail,
          participants: [
            {
              user: {
                uuid: '{reviewer-uuid}',
                nickname: 'bob',
                display_name: 'Bob',
                links: { avatar: { href: 'https://bitbucket.org/account/bob/avatar/32' } },
              },
              role: 'REVIEWER',
              approved: true,
              state: 'approved',
            },
          ],
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const status = await getReviewStatus(ORG_OWNER, 'acme', 'repo', 12);

    expect(status.participants[0].avatarUrl).toBe('https://bitbucket.org/account/bob/avatar/32');
  });
});
