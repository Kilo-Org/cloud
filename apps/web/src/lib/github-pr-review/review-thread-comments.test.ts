/**
 * @jest-environment node
 */
import {
  CONVERSATION_COMMENTS_QUERY_FOR_TEST,
  enrichReviewThreads,
  fetchAllThreadComments,
  REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY_FOR_TEST,
} from '@/routers/github-pr-review-router';
import {
  REVIEW_THREAD_COMMENTS_MAX_PER_REQUEST,
  REVIEW_THREAD_COMMENTS_PAGE_SIZE,
} from '@/lib/github-pr-review/dtos';

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
      budget: { remainingFollowUpComments: REVIEW_THREAD_COMMENTS_MAX_PER_REQUEST },
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
      budget: { remainingFollowUpComments: REVIEW_THREAD_COMMENTS_MAX_PER_REQUEST },
    });

    expect(comments[0]?.reactions).toEqual([
      { content: 'THUMBS_UP', count: 3, viewerHasReacted: true },
      { content: 'HEART', count: 1, viewerHasReacted: false },
    ]);
  });
});

function commentPage(startId: number, count: number, hasNextPage: boolean) {
  return {
    pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor_${startId + count}` : null },
    nodes: Array.from({ length: count }, (_, index) => commentNode(startId + index)),
  };
}

function threadNode(index: number, comments: ReturnType<typeof commentPage>) {
  return {
    id: `thread_${index}`,
    isResolved: false,
    isOutdated: false,
    subjectType: 'LINE' as const,
    path: `src/file-${index}.ts`,
    line: index + 1,
    startLine: null,
    originalLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT' as const,
    comments,
  };
}

describe('thread comment pagination bounds', () => {
  it('stops at the per-thread page ceiling while GitHub keeps reporting another page', async () => {
    let nextId = 1000;
    const request = jest.fn(async () => {
      const start = nextId;
      nextId += REVIEW_THREAD_COMMENTS_PAGE_SIZE;
      return {
        data: {
          data: {
            node: { comments: commentPage(start, REVIEW_THREAD_COMMENTS_PAGE_SIZE, true) },
          },
        },
      };
    });

    const comments = await fetchAllThreadComments({
      octokit: { request } as never,
      threadId: 'thread_1',
      initialConnection: commentPage(1, REVIEW_THREAD_COMMENTS_PAGE_SIZE, true),
      // Far above the per-thread ceiling: the page ceiling is the binding cap.
      budget: { remainingFollowUpComments: 1_000_000 },
    });

    expect(request).toHaveBeenCalledTimes(5);
    // Initial page plus the 5-follow-up-page ceiling, 50 comments per page.
    expect(comments).toHaveLength(300);
  });

  it('spends one follow-up budget across threads and stops asking once it is empty', async () => {
    // One page of 50 plus 10 from the next page, then the budget is spent.
    const budget = { remainingFollowUpComments: 60 };
    let nextId = 5000;
    const request = jest.fn(async () => {
      const start = nextId;
      nextId += REVIEW_THREAD_COMMENTS_PAGE_SIZE;
      return {
        data: {
          data: {
            node: { comments: commentPage(start, REVIEW_THREAD_COMMENTS_PAGE_SIZE, true) },
          },
        },
      };
    });

    const first = await fetchAllThreadComments({
      octokit: { request } as never,
      threadId: 'thread_1',
      initialConnection: commentPage(1, 1, true),
      budget,
    });
    const requestsAfterFirst = request.mock.calls.length;
    const second = await fetchAllThreadComments({
      octokit: { request } as never,
      threadId: 'thread_2',
      initialConnection: commentPage(2, 1, true),
      budget,
    });

    expect(request).toHaveBeenCalledTimes(requestsAfterFirst);
    expect(first).toHaveLength(61);
    expect(second).toHaveLength(1);
    expect(budget.remainingFollowUpComments).toBe(0);
  });

  it('never runs more than the configured number of thread comment requests at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const request = jest.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield one microtask so every concurrent slot is observed as in flight
      // before any request settles; no wall-clock delay is involved.
      await Promise.resolve();
      inFlight -= 1;
      return { data: { data: { node: { comments: commentPage(9000, 1, false) } } } };
    });
    const nodes = Array.from({ length: 15 }, (_, index) =>
      threadNode(index, commentPage(index * 10 + 1, 1, true))
    );

    const threads = await enrichReviewThreads({ octokit: { request } as never, nodes });

    expect(threads).toHaveLength(nodes.length);
    expect(request).toHaveBeenCalledTimes(nodes.length);
    expect(maxInFlight).toBe(5);
  });

  it('caps follow-up comments per request while every thread keeps its initial page', async () => {
    const request = jest.fn(async () => ({
      data: {
        data: {
          node: {
            comments: commentPage(2000, REVIEW_THREAD_COMMENTS_PAGE_SIZE, true),
          },
        },
      },
    }));
    const threadCount = 20;
    const nodes = Array.from({ length: threadCount }, (_, index) =>
      threadNode(index, commentPage(index * 10 + 1, 1, true))
    );

    const threads = await enrichReviewThreads({ octokit: { request } as never, nodes });

    const collected = threads.reduce((total, thread) => total + thread.comments.length, 0);
    expect(collected - threadCount).toBe(500);
    // Threads reached after the budget is spent still carry their initial page.
    expect(threads.some(thread => thread.comments.length === 1)).toBe(true);
    expect(threads.every(thread => thread.comments.length >= 1)).toBe(true);
  });
});
