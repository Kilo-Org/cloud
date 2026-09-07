import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import {
  addComment,
  BITBUCKET_AUTO_MERGE_UNSUPPORTED_REASON,
  BITBUCKET_PR_REVIEW_CAPABILITIES,
  BITBUCKET_REACTIONS_UNSUPPORTED_REASON,
  BITBUCKET_STALE_HEAD_REASON,
  BITBUCKET_THREAD_RESOLUTION_UNSUPPORTED_REASON,
  mergePullRequest,
  replyToComment,
  resolveThread,
  submitReview,
} from './bitbucket-write';
import { BitbucketReviewError } from './bitbucket-authorization';

const mockGetBitbucketWorkspaceAccessTokenStatus = jest.fn();
const mockReadCachedRepositories = jest.fn();

jest.mock('@/lib/integrations/platforms/bitbucket/workspace-access-token-repository-cache', () => ({
  getBitbucketWorkspaceAccessTokenStatus: (...args: unknown[]) =>
    mockGetBitbucketWorkspaceAccessTokenStatus(...args),
  readCachedBitbucketWorkspaceAccessTokenRepositories: (input: unknown) =>
    mockReadCachedRepositories(input),
}));

jest.mock('@/lib/config.server', () => ({
  GIT_TOKEN_SERVICE_API_URL: 'https://token-service.example.com',
}));

jest.mock('@/lib/tokens', () => ({
  generateInternalServiceToken: jest.fn(() => 'svc-mock-token'),
  TOKEN_EXPIRY: { fiveMinutes: 300 },
}));

jest.mock('@/lib/utils.server', () => ({
  logExceptInTest: () => {},
  warnExceptInTest: () => {},
}));

const ORG_OWNER = {
  type: 'organization' as const,
  organizationId: 'org_1',
  userId: 'user_1',
};

const WORKSPACE = {
  uuid: '12345678-1234-1234-1234-123456789012',
  slug: 'acme',
};

const HEAD_SHA = 'abc123def4567890';

const openPr = {
  id: 12,
  state: 'OPEN',
  source: { commit: { hash: HEAD_SHA } },
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
    const parsed = new URL(url.toString());
    if (url.toString().includes('token-service.example.com')) {
      return jsonResponse({
        status: 'available',
        token: 'at-mock-token',
        workspace: WORKSPACE,
      });
    }
    if (parsed.pathname === '/2.0/user') {
      return jsonResponse({ uuid: '{current-user-uuid}' });
    }
    if (parsed.pathname.endsWith('/pullrequests/12')) return jsonResponse(openPr);
    if (parsed.pathname.endsWith('/tasks')) {
      return jsonResponse({
        pagelen: 100,
        values: [{ id: 7, resolved_on: null, comment: { id: 101 } }],
        next: null,
      });
    }
    if (parsed.pathname.endsWith('/comments/101')) {
      // Bitbucket never sends task_count on comments; the write layer must
      // decide from the task collection alone.
      return jsonResponse({ id: 101 });
    }
    return jsonResponse({ pagelen: 50, values: [], next: null });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

function bitbucketCalls(): Array<{ url: URL; init: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .map(call => ({
      url: new URL(String(call[0])),
      init: (call[1] ?? {}) as Record<string, unknown>,
    }))
    .filter(call => call.url.hostname === 'api.bitbucket.org');
}

describe('addComment', () => {
  it('posts the raw content to the pull request comments collection', async () => {
    const result = await addComment({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      body: 'A review comment',
    });

    expect(result).toEqual({ done: true, replayed: false });
    const calls = bitbucketCalls();
    const post = calls.find(call => call.init.method === 'POST');
    expect(post?.url.pathname).toBe('/2.0/repositories/acme/repo/pullrequests/12/comments');
    expect(JSON.parse(String(post?.init.body))).toEqual({
      content: { raw: 'A review comment' },
    });
  });

  it('a RIGHT anchor posts an inline comment anchored on the destination line', async () => {
    await addComment({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      body: 'Inline on the new side',
      anchor: { path: 'src/deploy.ts', side: 'RIGHT', line: 42 },
    });

    const post = bitbucketCalls().find(call => call.init.method === 'POST');
    expect(JSON.parse(String(post?.init.body))).toEqual({
      content: { raw: 'Inline on the new side' },
      inline: { path: 'src/deploy.ts', to: 42 },
    });
  });

  it('a LEFT anchor posts an inline comment anchored on the source line', async () => {
    await addComment({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      body: 'Inline on the old side',
      anchor: { path: 'src/deploy.ts', side: 'LEFT', line: 7 },
    });

    const post = bitbucketCalls().find(call => call.init.method === 'POST');
    expect(JSON.parse(String(post?.init.body))).toEqual({
      content: { raw: 'Inline on the old side' },
      inline: { path: 'src/deploy.ts', from: 7 },
    });
  });

  it('a RIGHT startLine range anchors the destination line, never an unrelated source line', async () => {
    await addComment({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      body: 'This block',
      anchor: { path: 'src/deploy.ts', side: 'RIGHT', line: 20, startLine: 10 },
    });

    const post = bitbucketCalls().find(call => call.init.method === 'POST');
    // Bitbucket's from/to are source-side and destination-side line numbers,
    // not a one-sided range: `from: startLine` would anchor an unrelated old
    // line. The range anchors its end line on the tapped (destination) side.
    expect(JSON.parse(String(post?.init.body))).toEqual({
      content: { raw: 'This block' },
      inline: { path: 'src/deploy.ts', to: 20 },
    });
  });

  it('a LEFT startLine range anchors the source line, never an invented new-side line', async () => {
    await addComment({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      body: 'This block',
      anchor: { path: 'src/deploy.ts', side: 'LEFT', line: 20, startLine: 10 },
    });

    const post = bitbucketCalls().find(call => call.init.method === 'POST');
    expect(JSON.parse(String(post?.init.body))).toEqual({
      content: { raw: 'This block' },
      inline: { path: 'src/deploy.ts', from: 20 },
    });
  });

  it('classifies a provider 400 on an anchored comment as bad_request', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      return new Response(null, { status: 400 });
    });

    const error = await captureRejection(
      addComment({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        body: 'x',
        anchor: { path: 'src/deploy.ts', side: 'RIGHT', line: 999_999 },
      })
    );

    expect(error.kind).toBe('bad_request');
    expect(error.retryable).toBe(false);
  });

  it('maps a provider 403 to non-retryable forbidden', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      if (new URL(full).pathname === '/2.0/user') return jsonResponse({ uuid: '{u}' });
      return new Response(null, { status: 403 });
    });

    const error = await captureRejection(
      addComment({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        body: 'Nope',
      })
    );

    expect(error).toBeInstanceOf(BitbucketReviewError);
    expect(error.kind).toBe('forbidden');
    expect(error.retryable).toBe(false);
  });
});

describe('replyToComment', () => {
  it('posts a reply carrying the parent comment id', async () => {
    const result = await replyToComment({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      commentId: '101',
      body: 'A reply',
    });

    expect(result).toEqual({ done: true, replayed: false });
    const calls = bitbucketCalls();
    const post = calls.find(call => call.init.method === 'POST');
    expect(post?.url.pathname).toBe('/2.0/repositories/acme/repo/pullrequests/12/comments');
    expect(JSON.parse(String(post?.init.body))).toEqual({
      content: { raw: 'A reply' },
      parent: { id: 101 },
    });
  });

  it('refuses a non-numeric comment id as bad_request without any provider call', async () => {
    const error = await captureRejection(
      replyToComment({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        commentId: 'not-a-number',
        body: 'A reply',
      })
    );

    expect(error.kind).toBe('bad_request');
    expect(bitbucketCalls()).toEqual([]);
  });
});

describe('submitReview', () => {
  it('maps approve to the participants state approved for the connected identity', async () => {
    const result = await submitReview({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      event: 'approve',
    });

    expect(result).toEqual({ done: true, replayed: false });
    const put = bitbucketCalls().find(
      call => call.init.method === 'PUT' && call.url.pathname.includes('/participants/')
    );
    expect(put?.url.pathname).toBe(
      '/2.0/repositories/acme/repo/pullrequests/12/participants/%7Bcurrent-user-uuid%7D'
    );
    expect(JSON.parse(String(put?.init.body))).toEqual({ state: 'approved' });
  });

  it('maps request_changes to participants state changes_requested', async () => {
    const result = await submitReview({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      event: 'request_changes',
    });

    expect(result).toEqual({ done: true, replayed: false });
    const put = bitbucketCalls().find(
      call => call.init.method === 'PUT' && call.url.pathname.includes('/participants/')
    );
    expect(JSON.parse(String(put?.init.body))).toEqual({
      state: 'changes_requested',
    });
  });

  it('maps comment to clearing the own approval state and posts the body', async () => {
    const result = await submitReview({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      event: 'comment',
      body: 'Read this first',
    });

    expect(result).toEqual({ done: true, replayed: false });
    const put = bitbucketCalls().find(
      call => call.init.method === 'PUT' && call.url.pathname.includes('/participants/')
    );
    expect(JSON.parse(String(put?.init.body))).toEqual({ state: null });
    const post = bitbucketCalls().find(call => call.init.method === 'POST');
    expect(JSON.parse(String(post?.init.body))).toEqual({
      content: { raw: 'Read this first' },
    });
  });

  it('refuses a comment review without a body before any provider call', async () => {
    const error = await captureRejection(
      submitReview({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        event: 'comment',
      })
    );

    expect(error.kind).toBe('bad_request');
    expect(bitbucketCalls()).toEqual([]);
  });

  it('posts every inline comment before the review state and the summary comment', async () => {
    const result = await submitReview({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      event: 'approve',
      body: 'LGTM',
      comments: [
        { path: 'a.ts', side: 'RIGHT', line: 3, body: 'first inline' },
        {
          path: 'b.ts',
          side: 'LEFT',
          line: 9,
          startLine: 4,
          body: 'second inline',
        },
      ],
    });

    expect(result).toEqual({ done: true, replayed: false });
    const effects = bitbucketCalls().filter(
      call => call.init.method === 'POST' || call.init.method === 'PUT'
    );
    expect(effects.map(call => `${String(call.init.method)} ${call.url.pathname}`)).toEqual([
      'POST /2.0/repositories/acme/repo/pullrequests/12/comments',
      'POST /2.0/repositories/acme/repo/pullrequests/12/comments',
      'PUT /2.0/repositories/acme/repo/pullrequests/12/participants/%7Bcurrent-user-uuid%7D',
      'POST /2.0/repositories/acme/repo/pullrequests/12/comments',
    ]);
    expect(JSON.parse(String(effects[0].init.body))).toEqual({
      content: { raw: 'first inline' },
      inline: { path: 'a.ts', to: 3 },
    });
    expect(JSON.parse(String(effects[1].init.body))).toEqual({
      content: { raw: 'second inline' },
      // A LEFT range anchors its end line on the source side.
      inline: { path: 'b.ts', from: 9 },
    });
    expect(JSON.parse(String(effects[3].init.body))).toEqual({
      content: { raw: 'LGTM' },
    });
  });

  it('a comment event with a batch and no body still posts the inline comments and clears approval', async () => {
    const result = await submitReview({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      event: 'comment',
      comments: [{ path: 'a.ts', side: 'RIGHT', line: 3, body: 'inline only' }],
    });

    expect(result).toEqual({ done: true, replayed: false });
    const effects = bitbucketCalls().filter(
      call => call.init.method === 'POST' || call.init.method === 'PUT'
    );
    expect(effects).toHaveLength(2);
    expect(JSON.parse(String(effects[0].init.body))).toEqual({
      content: { raw: 'inline only' },
      inline: { path: 'a.ts', to: 3 },
    });
    expect(JSON.parse(String(effects[1].init.body))).toEqual({ state: null });
  });

  it('a mid-batch rejection after a committed comment reports the ambiguous retryable kind', async () => {
    let posts = 0;
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      const parsed = new URL(full);
      if (parsed.pathname === '/2.0/user') return jsonResponse({ uuid: '{current-user-uuid}' });
      if (parsed.pathname.endsWith('/comments')) {
        posts += 1;
        return posts === 1
          ? jsonResponse({ id: 101 })
          : jsonResponse({ error: { message: 'inline position invalid' } }, 400);
      }
      return jsonResponse({});
    });

    const error = await captureRejection(
      submitReview({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        event: 'approve',
        body: 'LGTM',
        comments: [
          { path: 'a.ts', side: 'RIGHT', line: 3, body: 'first' },
          { path: 'b.ts', side: 'RIGHT', line: 4, body: 'outside' },
        ],
      })
    );

    // The first inline comment already committed: a deterministic
    // bad_request would settle the ledger row failed, and the client's
    // key-rotating retry would re-post that comment as a duplicate. The
    // retryable kind keeps the row reconcile_pending instead.
    expect(error.kind).toBe('retryable');
    expect(error.retryable).toBe(true);
    // The failure stops the batch: no participants write, no summary comment.
    expect(bitbucketCalls().some(call => call.init.method === 'PUT')).toBe(false);
    expect(posts).toBe(2);
  });

  it('a rejection on the first comment, with nothing committed, keeps the deterministic bad_request', async () => {
    let posts = 0;
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      const parsed = new URL(full);
      if (parsed.pathname === '/2.0/user') return jsonResponse({ uuid: '{current-user-uuid}' });
      if (parsed.pathname.endsWith('/comments')) {
        posts += 1;
        return jsonResponse({ error: { message: 'inline position invalid' } }, 400);
      }
      return jsonResponse({});
    });

    const error = await captureRejection(
      submitReview({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        event: 'approve',
        body: 'LGTM',
        comments: [
          { path: 'a.ts', side: 'RIGHT', line: 999_999, body: 'outside' },
          { path: 'b.ts', side: 'RIGHT', line: 4, body: 'second' },
        ],
      })
    );

    expect(error.kind).toBe('bad_request');
    expect(error.retryable).toBe(false);
    // The batch stops at the refused comment: the second never posts.
    expect(posts).toBe(1);
  });

  it('a participants-write rejection after the whole batch committed is a partial apply too', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      const parsed = new URL(full);
      if (parsed.pathname === '/2.0/user') return jsonResponse({ uuid: '{current-user-uuid}' });
      if (parsed.pathname.includes('/participants/')) {
        return jsonResponse({ error: { message: 'forbidden' } }, 403);
      }
      return jsonResponse({ id: 101 });
    });

    const error = await captureRejection(
      submitReview({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        event: 'approve',
        body: 'LGTM',
        comments: [{ path: 'a.ts', side: 'RIGHT', line: 3, body: 'first' }],
      })
    );

    // The inline comment committed before the review state was refused: a
    // failed settle would let the retry re-post it as a duplicate.
    expect(error.kind).toBe('retryable');
    expect(error.retryable).toBe(true);
    // The summary comment never posts.
    expect(
      bitbucketCalls().filter(call => String(call.url.pathname).endsWith('/comments'))
    ).toHaveLength(1);
  });
});

describe('resolveThread', () => {
  it('resolves the comment task when one exists', async () => {
    const result = await resolveThread({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      threadId: '101',
    });

    expect(result).toEqual({ done: true, replayed: false });
    const put = bitbucketCalls().find(call => call.init.method === 'PUT');
    expect(put?.url.pathname).toBe('/2.0/repositories/acme/repo/pullrequests/12/tasks/7');
    expect(JSON.parse(String(put?.init.body))).toEqual({ resolved: true });
  });

  it('refuses a thread without a task with the capability reason', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      const parsed = new URL(full);
      if (parsed.pathname.endsWith('/comments/101')) return jsonResponse({ id: 101 });
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const error = await captureRejection(
      resolveThread({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        threadId: '101',
      })
    );

    expect(error.kind).toBe('bad_request');
    expect(error.message).toBe(BITBUCKET_THREAD_RESOLUTION_UNSUPPORTED_REASON);
  });

  it('refuses a thread whose tasks all belong to other comments with the capability reason', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      const parsed = new URL(full);
      if (parsed.pathname === '/2.0/user') return jsonResponse({ uuid: '{u}' });
      if (parsed.pathname.endsWith('/comments/101')) return jsonResponse({ id: 101 });
      if (parsed.pathname.endsWith('/tasks')) {
        return jsonResponse({
          pagelen: 100,
          values: [{ id: 6, resolved_on: null, comment: { id: 202 } }],
          next: null,
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const error = await captureRejection(
      resolveThread({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        threadId: '101',
      })
    );

    expect(error.kind).toBe('bad_request');
    expect(error.message).toBe(BITBUCKET_THREAD_RESOLUTION_UNSUPPORTED_REASON);
    expect(bitbucketCalls().some(call => call.init.method === 'PUT')).toBe(false);
  });

  it('refuses with the capability reason when the task collection is not exposed', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      const parsed = new URL(full);
      if (parsed.pathname === '/2.0/user') return jsonResponse({ uuid: '{u}' });
      if (parsed.pathname.endsWith('/comments/101')) return jsonResponse({ id: 101 });
      if (parsed.pathname.endsWith('/tasks')) return new Response(null, { status: 404 });
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const error = await captureRejection(
      resolveThread({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        threadId: '101',
      })
    );

    expect(error.kind).toBe('bad_request');
    expect(error.message).toBe(BITBUCKET_THREAD_RESOLUTION_UNSUPPORTED_REASON);
  });

  it('reports replayed when the task is already resolved', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      const parsed = new URL(full);
      if (parsed.pathname === '/2.0/user') return jsonResponse({ uuid: '{u}' });
      if (parsed.pathname.endsWith('/comments/101')) return jsonResponse({ id: 101 });
      if (parsed.pathname.endsWith('/tasks')) {
        return jsonResponse({
          pagelen: 100,
          values: [
            {
              id: 7,
              resolved_on: '2026-09-06T00:00:00.000Z',
              comment: { id: 101 },
            },
          ],
          next: null,
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await resolveThread({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      threadId: '101',
    });

    expect(result).toEqual({ done: true, replayed: true });
    expect(bitbucketCalls().some(call => call.init.method === 'PUT')).toBe(false);
  });

  it('follows the paginated task collection and resolves the task on a later page', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      const parsed = new URL(full);
      if (parsed.pathname.endsWith('/comments/101')) return jsonResponse({ id: 101 });
      if (parsed.pathname.endsWith('/tasks')) {
        return parsed.searchParams.get('page') === '2'
          ? jsonResponse({
              pagelen: 100,
              values: [{ id: 7, resolved_on: null, comment: { id: 101 } }],
              next: null,
            })
          : jsonResponse({
              pagelen: 100,
              values: [{ id: 6, resolved_on: null, comment: { id: 202 } }],
              next: 'https://api.bitbucket.org/2.0/repositories/acme/repo/pullrequests/12/tasks?pagelen=100&page=2',
            });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await resolveThread({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      threadId: '101',
    });

    expect(result).toEqual({ done: true, replayed: false });
    const put = bitbucketCalls().find(call => call.init.method === 'PUT');
    expect(put?.url.pathname).toBe('/2.0/repositories/acme/repo/pullrequests/12/tasks/7');
    expect(JSON.parse(String(put?.init.body))).toEqual({ resolved: true });
    // The collection was followed to page 2 before the task resolved.
    expect(bitbucketCalls().filter(call => call.url.pathname.endsWith('/tasks'))).toHaveLength(2);
  });

  it('concludes replayed only after the whole task collection is exhausted', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      const parsed = new URL(full);
      if (parsed.pathname.endsWith('/comments/101')) return jsonResponse({ id: 101 });
      if (parsed.pathname.endsWith('/tasks')) {
        return parsed.searchParams.get('page') === '2'
          ? jsonResponse({
              pagelen: 100,
              values: [
                {
                  id: 7,
                  resolved_on: '2026-09-06T00:00:00.000Z',
                  comment: { id: 101 },
                },
              ],
              next: null,
            })
          : jsonResponse({
              pagelen: 100,
              values: [{ id: 6, resolved_on: null, comment: { id: 202 } }],
              next: 'https://api.bitbucket.org/2.0/repositories/acme/repo/pullrequests/12/tasks?pagelen=100&page=2',
            });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await resolveThread({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      threadId: '101',
    });

    expect(result).toEqual({ done: true, replayed: true });
    expect(bitbucketCalls().some(call => call.init.method === 'PUT')).toBe(false);
  });

  it('refuses a non-numeric thread id as not_found without a provider call', async () => {
    const error = await captureRejection(
      resolveThread({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        threadId: 'not-a-number',
      })
    );

    expect(error.kind).toBe('not_found');
    expect(bitbucketCalls()).toEqual([]);
  });
});

describe('mergePullRequest', () => {
  it('re-fetches the PR, fences the head, and merges the exact revision', async () => {
    const result = await mergePullRequest({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      expectedHeadSha: HEAD_SHA,
      closeSourceBranch: true,
      commitMessage: 'Merged in feature/retry',
    });

    expect(result).toEqual({ done: true, replayed: false });
    const post = bitbucketCalls().find(call => call.init.method === 'POST');
    expect(post?.url.pathname).toBe('/2.0/repositories/acme/repo/pullrequests/12/merge');
    expect(JSON.parse(String(post?.init.body))).toEqual({
      close_source_branch: true,
      commit_message: 'Merged in feature/retry',
    });
  });

  it('refuses a stale revision with the exact reason and never merges', async () => {
    const error = await captureRejection(
      mergePullRequest({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        expectedHeadSha: 'stale-sha',
      })
    );

    expect(error.kind).toBe('stale_head');
    expect(error.message).toBe(BITBUCKET_STALE_HEAD_REASON);
    expect(bitbucketCalls().some(call => call.url.pathname.endsWith('/merge'))).toBe(false);
  });

  it('reports replayed when the PR is already merged', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      const parsed = new URL(full);
      if (parsed.pathname.endsWith('/pullrequests/12')) {
        return jsonResponse({
          id: 12,
          state: 'MERGED',
          source: { commit: { hash: HEAD_SHA } },
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const result = await mergePullRequest({
      owner: ORG_OWNER,
      workspace: 'acme',
      repoSlug: 'repo',
      prId: 12,
      expectedHeadSha: HEAD_SHA,
    });

    expect(result).toEqual({ done: true, replayed: true });
    expect(bitbucketCalls().some(call => call.init.method === 'POST')).toBe(false);
  });

  it('refuses a closed PR with a non-retryable bad_request', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const full = url.toString();
      if (full.includes('token-service.example.com')) {
        return jsonResponse({
          status: 'available',
          token: 'at-mock-token',
          workspace: WORKSPACE,
        });
      }
      const parsed = new URL(full);
      if (parsed.pathname.endsWith('/pullrequests/12')) {
        return jsonResponse({
          id: 12,
          state: 'DECLINED',
          source: { commit: { hash: HEAD_SHA } },
        });
      }
      return jsonResponse({ pagelen: 50, values: [], next: null });
    });

    const error = await captureRejection(
      mergePullRequest({
        owner: ORG_OWNER,
        workspace: 'acme',
        repoSlug: 'repo',
        prId: 12,
        expectedHeadSha: HEAD_SHA,
      })
    );

    expect(error.kind).toBe('bad_request');
    expect(error.retryable).toBe(false);
  });
});

describe('capabilities and reasons', () => {
  it('auto-merge is always unsupported with the provider reason', () => {
    expect(BITBUCKET_PR_REVIEW_CAPABILITIES.autoMerge).toEqual({
      supported: false,
      reason: 'Bitbucket Cloud does not expose auto-merge in its API',
    });
  });

  it('reactions are unsupported with the provider reason', () => {
    expect(BITBUCKET_PR_REVIEW_CAPABILITIES.reactions).toEqual({
      supported: false,
      reason: 'Bitbucket Cloud does not expose reactions on pull request comments',
    });
  });

  it('review events include request_changes', () => {
    expect(BITBUCKET_PR_REVIEW_CAPABILITIES.reviewEvents).toEqual([
      'approve',
      'request_changes',
      'comment',
    ]);
  });

  it('the exported reasons match the shared capability copy', () => {
    expect(BITBUCKET_AUTO_MERGE_UNSUPPORTED_REASON).toBe(
      BITBUCKET_PR_REVIEW_CAPABILITIES.autoMerge.reason
    );
    expect(BITBUCKET_REACTIONS_UNSUPPORTED_REASON).toBe(
      BITBUCKET_PR_REVIEW_CAPABILITIES.reactions.reason
    );
  });
});
