/**
 * @jest-environment node
 */
import {
  CONVERSATION_COMMENTS_QUERY_FOR_TEST,
  fetchAllThreadComments,
  REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY_FOR_TEST,
} from '@/routers/github-pr-review-router';

function commentNode(
  id: number,
  reactionGroups?: Array<{
    content: string;
    viewerHasReacted: boolean;
    reactors: { totalCount: number };
  }>
) {
  return {
    databaseId: id,
    id: `node_${id}`,
    body: `comment ${id}`,
    createdAt: '2024-01-01T00:00:00Z',
    author: { login: 'octocat', avatarUrl: 'https://x/y.png' },
    // Live GitHub shape: unpaginated reactionGroups list (all group types).
    reactionGroups: reactionGroups ?? [
      {
        content: 'THUMBS_UP',
        viewerHasReacted: false,
        reactors: { totalCount: 0 },
      },
      {
        content: 'THUMBS_DOWN',
        viewerHasReacted: false,
        reactors: { totalCount: 0 },
      },
      {
        content: 'LAUGH',
        viewerHasReacted: false,
        reactors: { totalCount: 0 },
      },
      {
        content: 'HOORAY',
        viewerHasReacted: false,
        reactors: { totalCount: 0 },
      },
      {
        content: 'CONFUSED',
        viewerHasReacted: false,
        reactors: { totalCount: 0 },
      },
      {
        content: 'HEART',
        viewerHasReacted: false,
        reactors: { totalCount: 0 },
      },
      {
        content: 'ROCKET',
        viewerHasReacted: false,
        reactors: { totalCount: 0 },
      },
      { content: 'EYES', viewerHasReacted: false, reactors: { totalCount: 0 } },
    ],
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
    // Zero-count reactionGroups are dropped; DTO reactions stay empty.
    expect(comments.map(c => c.reactions)).toEqual([[], [], []]);
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

  // Production GraphQL contract for top-level PR conversation comments.
  // `reactors` is a connection; GitHub rejects the query without first/last.
  // The local stub harness cannot catch a bare `reactors` regression.
  it('locks CONVERSATION_COMMENTS_QUERY load-bearing selection shape', () => {
    expect(CONVERSATION_COMMENTS_QUERY_FOR_TEST).toMatch(/query\s+PrReviewConversationComments\b/);
    // Operation must select PR conversation comments (not review threads).
    expect(CONVERSATION_COMMENTS_QUERY_FOR_TEST).toMatch(
      /pullRequest\s*\([^)]*\)\s*\{\s*comments\s*\(/
    );
    expect(CONVERSATION_COMMENTS_QUERY_FOR_TEST).toContain('reactors(first: 0)');
    // Bare `reactors {` is invalid GraphQL against GitHub (connection needs first/last).
    expect(CONVERSATION_COMMENTS_QUERY_FOR_TEST).not.toMatch(/reactors\s*\{/);
  });

  it('keeps only reactionGroups with totalCount > 0 in the DTO shape', async () => {
    const comments = await fetchAllThreadComments({
      octokit: { request: jest.fn() } as never,
      threadId: 'thread_1',
      initialConnection: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          commentNode(1, [
            {
              content: 'THUMBS_UP',
              viewerHasReacted: true,
              reactors: { totalCount: 3 },
            },
            {
              content: 'THUMBS_DOWN',
              viewerHasReacted: false,
              reactors: { totalCount: 0 },
            },
            {
              content: 'LAUGH',
              viewerHasReacted: false,
              reactors: { totalCount: 0 },
            },
            {
              content: 'HOORAY',
              viewerHasReacted: false,
              reactors: { totalCount: 0 },
            },
            {
              content: 'CONFUSED',
              viewerHasReacted: false,
              reactors: { totalCount: 0 },
            },
            {
              content: 'HEART',
              viewerHasReacted: false,
              reactors: { totalCount: 1 },
            },
            {
              content: 'ROCKET',
              viewerHasReacted: false,
              reactors: { totalCount: 0 },
            },
            {
              content: 'EYES',
              viewerHasReacted: false,
              reactors: { totalCount: 0 },
            },
          ]),
        ],
      },
    });

    expect(comments[0]?.reactions).toEqual([
      { content: 'THUMBS_UP', count: 3, viewerHasReacted: true },
      { content: 'HEART', count: 1, viewerHasReacted: false },
    ]);
  });
});
