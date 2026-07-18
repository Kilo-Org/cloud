/**
 * @jest-environment node
 */
import {
  fetchAllThreadComments,
  REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY_FOR_TEST,
} from '@/routers/github-pr-review-router';

function commentNode(id: number) {
  return {
    databaseId: id,
    id: `node_${id}`,
    body: `comment ${id}`,
    createdAt: '2024-01-01T00:00:00Z',
    author: { login: 'octocat', avatarUrl: 'https://x/y.png' },
    reactions: { nodes: [] },
  };
}

describe('fetchAllThreadComments', () => {
  it('follows the comment cursor until hasNextPage is false and uses only valid variables', async () => {
    const request = jest
      .fn()
      // page 2
      .mockResolvedValueOnce({
        data: {
          data: {
            node: {
              comments: {
                pageInfo: { hasNextPage: true, endCursor: 'c2' },
                nodes: [commentNode(2)],
              },
            },
          },
        },
      })
      // page 3 (final)
      .mockResolvedValueOnce({
        data: {
          data: {
            node: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [commentNode(3)],
              },
            },
          },
        },
      });

    const octokit = { request } as never;

    const comments = await fetchAllThreadComments({
      octokit,
      threadId: 'thread_1',
      initialConnection: {
        pageInfo: { hasNextPage: true, endCursor: 'c1' },
        nodes: [commentNode(1)],
      },
    });

    // All three pages aggregated to completion — no silent truncation.
    expect(comments.map(c => c.databaseId)).toEqual([1, 2, 3]);
    expect(request).toHaveBeenCalledTimes(2);

    // GraphQL variables must be nested under `variables` (GitHub — and a
    // faithful mock — ignore top-level params), and the follow-up query must
    // reference only $threadId/$first/$after (no unused $owner/$name/$number).
    const [, firstArgs] = request.mock.calls[0] as [string, Record<string, unknown>];
    expect(firstArgs.query).toBe(REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY_FOR_TEST);
    expect(firstArgs).toEqual({
      query: REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY_FOR_TEST,
      variables: { threadId: 'thread_1', first: 50, after: 'c1' },
    });
    expect(REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY_FOR_TEST).not.toMatch(/\$owner|\$name|\$number/);

    const [, secondArgs] = request.mock.calls[1] as [
      string,
      { variables: Record<string, unknown> },
    ];
    expect(secondArgs.variables.after).toBe('c2');
  });
});
