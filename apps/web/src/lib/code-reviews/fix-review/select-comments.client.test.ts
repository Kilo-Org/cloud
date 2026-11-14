import { describe, expect, it } from '@jest/globals';
import { Octokit } from '@octokit/rest';
import {
  createFixReviewCommentClient,
  FIX_REVIEW_COMMENTS_MAX_PAGES,
  FIX_REVIEW_COMMENTS_TOTAL_BODY_MAX_LENGTH,
} from './select-comments';

type FetchCall = { url: string; query: string | null; variables: Record<string, unknown> | null };

function octokitWithFetch(
  handler: (call: FetchCall) => unknown,
  linkHeader?: (call: FetchCall) => string | undefined
) {
  const calls: FetchCall[] = [];
  const octokit = new Octokit({
    auth: 'test-token',
    request: {
      fetch: async (url: string, options: { body?: unknown } = {}) => {
        const body = typeof options.body === 'string' ? options.body : null;
        const parsed = body === null ? null : JSON.parse(body);
        const call: FetchCall = {
          url,
          query: parsed?.query ?? null,
          variables: parsed?.variables ?? null,
        };
        calls.push(call);
        const link = linkHeader?.(call);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (link !== undefined) headers.link = link;
        return new Response(JSON.stringify(handler(call)), { status: 200, headers });
      },
    },
  });
  return { octokit, calls };
}

/** The `Link` header of a review-comment page, as GitHub writes it. */
function reviewCommentsLink(page: number, lastPage: number): string {
  const url = (target: number) =>
    `<https://api.github.com/repositories/1/pulls/7/comments?per_page=100&page=${target}>`;
  const segments: string[] = [];
  if (page < lastPage) segments.push(`${url(page + 1)}; rel="next"`);
  segments.push(`${url(lastPage)}; rel="last"`);
  return segments.join(', ');
}

const TARGET = { owner: 'owner', repo: 'repo', pullNumber: 7 };

describe('createFixReviewCommentClient', () => {
  it('preserves a definitive 401 from permission lookup for generation-safe rejection', async () => {
    const octokit = new Octokit({
      auth: 'synthetic-token',
      request: {
        fetch: async () => Response.json({ message: 'Bad credentials' }, { status: 401 }),
      },
    });
    await expect(
      createFixReviewCommentClient(octokit, TARGET).lookupPermission('reviewer')
    ).rejects.toMatchObject({ status: 401 });
  });
  it('lists every comment page and maps the author identity', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: 500 + index,
      path: 'src/file.ts',
      line: index + 1,
      body: `comment ${index}`,
      user: { login: 'reviewer', id: 1, type: 'User' },
    }));
    const secondPage = [
      {
        id: 900,
        in_reply_to_id: 899,
        path: 'src/other.ts',
        line: null,
        body: 'last comment',
        user: { login: 'kiloconnect[bot]', id: 240665456, type: 'Bot' },
      },
    ];
    const { octokit, calls } = octokitWithFetch(
      call => {
        const page = new URL(call.url).searchParams.get('page');
        return page === '2' ? secondPage : firstPage;
      },
      call => reviewCommentsLink(Number(new URL(call.url).searchParams.get('page')), 2)
    );

    const listing = await createFixReviewCommentClient(octokit, TARGET).listComments();

    expect(listing.comments).toHaveLength(101);
    expect(listing.unreadCount).toBe(0);
    expect(listing.comments.at(-1)).toEqual({
      id: 900,
      inReplyToId: 899,
      authorLogin: 'kiloconnect[bot]',
      authorType: 'Bot',
      authorId: 240665456,
      path: 'src/other.ts',
      line: null,
      body: 'last comment',
    });
    expect(calls).toHaveLength(2);
  });

  it('stops at the page bound and reports the older comments it did not read', async () => {
    const totalPages = FIX_REVIEW_COMMENTS_MAX_PAGES + 5;
    const commentPage = (page: number) =>
      Array.from({ length: 100 }, (_, index) => ({
        id: (page - 1) * 100 + index + 1,
        path: 'src/file.ts',
        line: index + 1,
        body: `comment ${(page - 1) * 100 + index + 1}`,
        user: { login: 'reviewer', id: 1, type: 'User' },
      }));
    const { octokit, calls } = octokitWithFetch(
      call => commentPage(Number(new URL(call.url).searchParams.get('page'))),
      call => reviewCommentsLink(Number(new URL(call.url).searchParams.get('page')), totalPages)
    );

    const listing = await createFixReviewCommentClient(octokit, TARGET).listComments();

    expect(calls).toHaveLength(FIX_REVIEW_COMMENTS_MAX_PAGES + 1);
    expect(listing.comments).toHaveLength(FIX_REVIEW_COMMENTS_MAX_PAGES * 100);
    expect(listing.unreadCount).toBe(totalPages * 100 - listing.comments.length);
    // The newest comments are kept, in the provider's oldest-first order.
    expect(listing.comments.at(-1)?.id).toBe(totalPages * 100);
    expect(listing.comments[0]?.id).toBe(totalPages * 100 - listing.comments.length + 1);
  });

  it('stops at the text budget and reports the comments it did not read', async () => {
    const body = 'x'.repeat(FIX_REVIEW_COMMENTS_TOTAL_BODY_MAX_LENGTH / 5);
    const totalPages = 3;
    const commentPage = (page: number) =>
      Array.from({ length: 100 }, (_, index) => ({
        id: (page - 1) * 100 + index + 1,
        path: 'src/file.ts',
        line: index + 1,
        body,
        user: { login: 'reviewer', id: 1, type: 'User' },
      }));
    const { octokit } = octokitWithFetch(
      call => commentPage(Number(new URL(call.url).searchParams.get('page'))),
      call => reviewCommentsLink(Number(new URL(call.url).searchParams.get('page')), totalPages)
    );

    const listing = await createFixReviewCommentClient(octokit, TARGET).listComments();

    expect(listing.comments).toHaveLength(100);
    expect(listing.unreadCount).toBe(totalPages * 100 - listing.comments.length);
    expect(listing.comments.at(-1)?.id).toBe(totalPages * 100);
  });

  it('finds the newest page when the header names no last page', async () => {
    const totalComments = 150;
    const body = 'x'.repeat(FIX_REVIEW_COMMENTS_TOTAL_BODY_MAX_LENGTH / 50);
    const commentPage = (page: number, size: number) =>
      Array.from({ length: size }, (_, index) => ({
        id: (page - 1) * 100 + index + 1,
        path: 'src/file.ts',
        line: index + 1,
        body,
        user: { login: 'reviewer', id: 1, type: 'User' },
      }));
    const pageOf = (call: FetchCall) => Number(new URL(call.url).searchParams.get('page'));
    const sizeOf = (call: FetchCall) => {
      const url = new URL(call.url);
      if (url.searchParams.get('per_page') === '1') return 1;
      return Number(url.searchParams.get('page')) === 2 ? 50 : 100;
    };
    const { octokit, calls } = octokitWithFetch(
      call => commentPage(pageOf(call), sizeOf(call)),
      call =>
        new URL(call.url).searchParams.get('per_page') === '1'
          ? reviewCommentsLink(1, totalComments)
          : '<https://api.github.com/repositories/1/pulls/7/comments?per_page=100&page=2>; rel="next"'
    );

    const listing = await createFixReviewCommentClient(octokit, TARGET).listComments();

    expect(listing.comments).toHaveLength(50);
    expect(listing.unreadCount).toBe(totalComments - listing.comments.length);
    expect(listing.comments.at(-1)?.id).toBe(totalComments);
    expect(calls).toHaveLength(3);
  });

  it('refuses a listing whose page count cannot be read', async () => {
    const commentPage = (size: number) =>
      Array.from({ length: size }, (_, index) => ({
        id: index + 1,
        path: 'src/file.ts',
        line: index + 1,
        body: 'comment',
        user: { login: 'reviewer', id: 1, type: 'User' },
      }));
    const { octokit } = octokitWithFetch(
      call => commentPage(new URL(call.url).searchParams.get('per_page') === '1' ? 1 : 100),
      () => '<https://api.github.com/repositories/1/pulls/7/comments?per_page=1&page=2>; rel="next"'
    );

    await expect(createFixReviewCommentClient(octokit, TARGET).listComments()).rejects.toThrow(
      'GitHub did not report the last page of the review comments'
    );
  });

  it('refuses a full first page whose next page holds comments', async () => {
    const commentPage = (page: number, size: number) =>
      Array.from({ length: size }, (_, index) => ({
        id: (page - 1) * 100 + index + 1,
        path: 'src/file.ts',
        line: index + 1,
        body: 'comment',
        user: { login: 'reviewer', id: 1, type: 'User' },
      }));
    const { octokit } = octokitWithFetch(call => {
      const page = Number(new URL(call.url).searchParams.get('page'));
      return commentPage(page, page === 1 ? 100 : 20);
    });

    await expect(createFixReviewCommentClient(octokit, TARGET).listComments()).rejects.toThrow(
      'GitHub did not report the last page of the review comments'
    );
  });

  it('reads a complete list whose first page is full', async () => {
    const commentPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      path: 'src/file.ts',
      line: index + 1,
      body: 'comment',
      user: { login: 'reviewer', id: 1, type: 'User' },
    }));
    const { octokit } = octokitWithFetch(call =>
      Number(new URL(call.url).searchParams.get('page')) === 1 ? commentPage : []
    );

    const listing = await createFixReviewCommentClient(octokit, TARGET).listComments();

    expect(listing.comments).toHaveLength(100);
    expect(listing.unreadCount).toBe(0);
  });

  it('reads a long review thread to its last page before deciding it is answered', async () => {
    const { octokit, calls } = octokitWithFetch(call => {
      if (call.query?.includes('FixReviewThreadComments')) {
        return {
          data: {
            node: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ databaseId: 12, author: { login: 'author' } }],
              },
            },
          },
        };
      }
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread-1',
                    isResolved: false,
                    comments: {
                      pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                      nodes: [{ databaseId: 11, author: { login: 'kiloconnect' } }],
                    },
                  },
                ],
              },
            },
          },
        },
      };
    });

    const settled = await createFixReviewCommentClient(octokit, TARGET).listSettledCommentIds(
      'author'
    );

    expect([...settled]).toEqual([11]);
    expect(calls.some(call => call.variables?.threadId === 'thread-1')).toBe(true);
  });

  it('fails when GitHub reports GraphQL errors', async () => {
    const { octokit } = octokitWithFetch(() => ({
      data: null,
      errors: [{ message: 'Resource not accessible by integration' }],
    }));

    await expect(
      createFixReviewCommentClient(octokit, TARGET).listSettledCommentIds('author')
    ).rejects.toThrow('GitHub reported errors while reading the review threads');
  });

  it('returns null when the permission lookup answers with an unknown value', async () => {
    const { octokit } = octokitWithFetch(() => ({ permission: 'maintain' }));

    const permission = await createFixReviewCommentClient(octokit, TARGET).lookupPermission(
      'octocat'
    );

    expect(permission).toBeNull();
  });
});
