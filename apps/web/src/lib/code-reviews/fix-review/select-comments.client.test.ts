import { describe, expect, it } from '@jest/globals';
import { Octokit } from '@octokit/rest';
import { createFixReviewCommentClient } from './select-comments';

type FetchCall = { url: string; query: string | null; variables: Record<string, unknown> | null };

function octokitWithFetch(handler: (call: FetchCall) => unknown) {
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
        return new Response(JSON.stringify(handler(call)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  });
  return { octokit, calls };
}

const TARGET = { owner: 'owner', repo: 'repo', pullNumber: 7 };

describe('createFixReviewCommentClient', () => {
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
    const { octokit } = octokitWithFetch(call => {
      const page = new URL(call.url).searchParams.get('page');
      return page === '2' ? secondPage : firstPage;
    });

    const comments = await createFixReviewCommentClient(octokit, TARGET).listComments();

    expect(comments).toHaveLength(101);
    expect(comments[100]).toEqual({
      id: 900,
      inReplyToId: 899,
      authorLogin: 'kiloconnect[bot]',
      authorType: 'Bot',
      authorId: 240665456,
      path: 'src/other.ts',
      line: null,
      body: 'last comment',
    });
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
