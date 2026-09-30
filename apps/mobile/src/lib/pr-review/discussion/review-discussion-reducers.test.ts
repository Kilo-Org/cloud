/* eslint-disable max-lines -- one suite for the resolve / reaction / comment-body / comment-removal reducers */
import { describe, expect, it } from 'vitest';

import {
  applyCommentBodyUpdate,
  applyCommentRemoval,
  applyReactionToggle,
  applyResolveToggle,
  type ConversationComment,
  findReviewComment,
  type ReviewComment,
  type ReviewThread,
  type ReviewThreadsInfiniteData,
} from './review-discussion-types';

function makeThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    threadId: 'T1',
    isResolved: false,
    isOutdated: false,
    subjectType: 'LINE',
    path: 'src/index.ts',
    line: 10,
    startLine: null,
    originalLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    diffHunk: null,
    comments: [
      {
        commentId: 1,
        nodeId: 'C1',
        author: { login: 'alice', avatarUrl: 'https://example.com/a.png' },
        bodyMarkdown: 'hello',
        createdAt: '2024-01-01T00:00:00Z',
        reactions: [{ content: 'THUMBS_UP', count: 2, viewerHasReacted: false }],
      },
    ],
    ...overrides,
  };
}

function makeData(threads: ReviewThread[]): ReviewThreadsInfiniteData {
  return {
    pages: [{ threads, conversation: [], nextCursor: null }],
    pageParams: [null],
  };
}

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    commentId: 1,
    nodeId: 'C1',
    author: { login: 'alice', avatarUrl: null },
    bodyMarkdown: 'hello',
    createdAt: '2024-01-01T00:00:00Z',
    reactions: [],
    ...overrides,
  };
}

function makeConversationComment(
  overrides: Partial<ConversationComment> = {}
): ConversationComment {
  return {
    commentId: 900,
    nodeId: 'IC900',
    author: { login: 'alice', avatarUrl: null },
    bodyMarkdown: 'issue body',
    createdAt: '2024-01-02T00:00:00Z',
    reactions: [],
    ...overrides,
  };
}

describe('applyResolveToggle', () => {
  it('flips the matching threadId to the next value', () => {
    const data = makeData([makeThread({ threadId: 'A' }), makeThread({ threadId: 'B' })]);
    const next = applyResolveToggle(data, 'A', true);
    expect(next?.pages[0]?.threads.find(t => t.threadId === 'A')?.isResolved).toBe(true);
    expect(next?.pages[0]?.threads.find(t => t.threadId === 'B')?.isResolved).toBe(false);
  });

  it('returns the same reference when no thread matched', () => {
    const data = makeData([makeThread({ threadId: 'A' })]);
    const next = applyResolveToggle(data, 'ZZZ', true);
    expect(next).toBe(data);
  });

  it('returns the same reference when the threadId matched but the value is already next', () => {
    const data = makeData([makeThread({ threadId: 'A', isResolved: true })]);
    const next = applyResolveToggle(data, 'A', true);
    expect(next).toBe(data);
  });

  it('returns undefined for undefined input', () => {
    expect(applyResolveToggle(undefined, 'A', true)).toBeUndefined();
  });

  it('walks all pages, not just the first', () => {
    const data: ReviewThreadsInfiniteData = {
      pages: [
        { threads: [makeThread({ threadId: 'A' })], conversation: [], nextCursor: 'p2' },
        { threads: [makeThread({ threadId: 'B' })], conversation: [], nextCursor: null },
      ],
      pageParams: [null, 'p2'],
    };
    const next = applyResolveToggle(data, 'B', true);
    expect(next?.pages[1]?.threads[0]?.isResolved).toBe(true);
    expect(next?.pages[0]?.threads[0]?.isResolved).toBe(false);
  });
});

describe('applyReactionToggle', () => {
  it('adds a reaction when the viewer is not yet reacted', () => {
    const data = makeData([
      makeThread({
        comments: [
          {
            commentId: 1,
            nodeId: 'C1',
            author: { login: 'alice', avatarUrl: null },
            bodyMarkdown: 'hi',
            createdAt: '2024-01-01T00:00:00Z',
            reactions: [{ content: 'THUMBS_UP', count: 2, viewerHasReacted: false }],
          },
        ],
      }),
    ]);
    const next = applyReactionToggle({
      data,
      threadId: 'T1',
      commentNodeId: 'C1',
      content: 'HEART',
    });
    const comment = findReviewComment(next, 'T1', 'C1');
    expect(comment?.reactions).toEqual([
      { content: 'THUMBS_UP', count: 2, viewerHasReacted: false },
      { content: 'HEART', count: 1, viewerHasReacted: true },
    ]);
  });

  it('removes a reaction when the viewer is already reacted', () => {
    const data = makeData([
      makeThread({
        comments: [
          {
            commentId: 1,
            nodeId: 'C1',
            author: { login: 'alice', avatarUrl: null },
            bodyMarkdown: 'hi',
            createdAt: '2024-01-01T00:00:00Z',
            reactions: [{ content: 'THUMBS_UP', count: 3, viewerHasReacted: true }],
          },
        ],
      }),
    ]);
    const next = applyReactionToggle({
      data,
      threadId: 'T1',
      commentNodeId: 'C1',
      content: 'THUMBS_UP',
    });
    const comment = findReviewComment(next, 'T1', 'C1');
    expect(comment?.reactions).toEqual([
      { content: 'THUMBS_UP', count: 2, viewerHasReacted: false },
    ]);
  });

  it('clamps the count at 0 on a remove-from-zero race', () => {
    const data = makeData([
      makeThread({
        comments: [
          {
            commentId: 1,
            nodeId: 'C1',
            author: { login: 'alice', avatarUrl: null },
            bodyMarkdown: 'hi',
            createdAt: '2024-01-01T00:00:00Z',
            reactions: [{ content: 'THUMBS_UP', count: 0, viewerHasReacted: true }],
          },
        ],
      }),
    ]);
    const next = applyReactionToggle({
      data,
      threadId: 'T1',
      commentNodeId: 'C1',
      content: 'THUMBS_UP',
    });
    const comment = findReviewComment(next, 'T1', 'C1');
    expect(comment?.reactions[0]?.count).toBe(0);
  });

  it('returns the same reference when no matching comment exists', () => {
    const data = makeData([makeThread()]);
    const next = applyReactionToggle({
      data,
      threadId: 'T1',
      commentNodeId: 'NOT-THERE',
      content: 'HEART',
    });
    expect(next).toBe(data);
  });

  it('returns the same reference when no matching thread exists', () => {
    const data = makeData([makeThread({ threadId: 'A' })]);
    const next = applyReactionToggle({
      data,
      threadId: 'ZZZ',
      commentNodeId: 'C1',
      content: 'HEART',
    });
    expect(next).toBe(data);
  });
});

describe('applyCommentBodyUpdate', () => {
  it('replaces the matching review comment body and leaves its thread-mate untouched', () => {
    const data = makeData([
      makeThread({
        comments: [
          makeComment({ commentId: 1, nodeId: 'C1', bodyMarkdown: 'first' }),
          makeComment({ commentId: 2, nodeId: 'C2', bodyMarkdown: 'reply' }),
        ],
      }),
    ]);
    const next = applyCommentBodyUpdate(data, { kind: 'review', commentId: 2, body: 'edited' });
    expect(findReviewComment(next, 'T1', 'C2')?.bodyMarkdown).toBe('edited');
    expect(findReviewComment(next, 'T1', 'C1')?.bodyMarkdown).toBe('first');
    expect(data.pages[0]?.threads[0]?.comments[1]?.bodyMarkdown).toBe('reply');
  });

  it('replaces the matching conversation comment body', () => {
    const data: ReviewThreadsInfiniteData = {
      pages: [
        {
          threads: [],
          conversation: [
            makeConversationComment({ commentId: 900, bodyMarkdown: 'before' }),
            makeConversationComment({ commentId: 901, nodeId: 'IC901', bodyMarkdown: 'other' }),
          ],
          nextCursor: null,
        },
      ],
      pageParams: [null],
    };
    const next = applyCommentBodyUpdate(data, {
      kind: 'conversation',
      commentId: 900,
      body: 'after',
    });
    expect(next?.pages[0]?.conversation[0]?.bodyMarkdown).toBe('after');
    expect(next?.pages[0]?.conversation[1]?.bodyMarkdown).toBe('other');
  });

  it('returns the same reference when no review comment matched', () => {
    const data = makeData([makeThread({ comments: [makeComment({ commentId: 1 })] })]);
    const next = applyCommentBodyUpdate(data, { kind: 'review', commentId: 999, body: 'edited' });
    expect(next).toBe(data);
  });

  it('returns the same reference when no conversation comment matched', () => {
    const data: ReviewThreadsInfiniteData = {
      pages: [
        {
          threads: [],
          conversation: [makeConversationComment({ commentId: 900 })],
          nextCursor: null,
        },
      ],
      pageParams: [null],
    };
    const next = applyCommentBodyUpdate(data, {
      kind: 'conversation',
      commentId: 999,
      body: 'edited',
    });
    expect(next).toBe(data);
  });

  it('walks every page, not just the first', () => {
    const data: ReviewThreadsInfiniteData = {
      pages: [
        {
          threads: [makeThread({ threadId: 'A', comments: [makeComment({ commentId: 1 })] })],
          conversation: [],
          nextCursor: 'p2',
        },
        {
          threads: [makeThread({ threadId: 'B', comments: [makeComment({ commentId: 2 })] })],
          conversation: [],
          nextCursor: null,
        },
      ],
      pageParams: [null, 'p2'],
    };
    const next = applyCommentBodyUpdate(data, { kind: 'review', commentId: 2, body: 'edited' });
    expect(next?.pages[1]?.threads[0]?.comments[0]?.bodyMarkdown).toBe('edited');
    expect(next?.pages[0]?.threads[0]?.comments[0]?.bodyMarkdown).toBe('hello');
  });

  it('returns undefined for undefined input', () => {
    expect(
      applyCommentBodyUpdate(undefined, { kind: 'review', commentId: 1, body: 'x' })
    ).toBeUndefined();
  });
});

describe('applyCommentRemoval', () => {
  it('drops the matching conversation comment row and keeps its neighbours', () => {
    const data: ReviewThreadsInfiniteData = {
      pages: [
        {
          threads: [],
          conversation: [
            makeConversationComment({ commentId: 900 }),
            makeConversationComment({ commentId: 901, nodeId: 'IC901' }),
          ],
          nextCursor: 'p2',
        },
      ],
      pageParams: [null],
    };
    const next = applyCommentRemoval(data, { kind: 'conversation', commentId: 900 });
    expect(next?.pages[0]?.conversation).toHaveLength(1);
    expect(next?.pages[0]?.conversation[0]?.commentId).toBe(901);
    expect(next?.pages[0]?.nextCursor).toBe('p2');
  });

  it('removes a review reply but keeps the thread and its root comment', () => {
    const data = makeData([
      makeThread({
        comments: [
          makeComment({ commentId: 1, nodeId: 'C1' }),
          makeComment({ commentId: 2, nodeId: 'C2' }),
        ],
      }),
    ]);
    const next = applyCommentRemoval(data, { kind: 'review', commentId: 2 });
    expect(next?.pages[0]?.threads).toHaveLength(1);
    expect(next?.pages[0]?.threads[0]?.comments.map(c => c.commentId)).toEqual([1]);
  });

  it('drops the whole thread when its root comment is removed', () => {
    const data = makeData([
      makeThread({ threadId: 'A', comments: [makeComment({ commentId: 1 })] }),
      makeThread({ threadId: 'B', comments: [makeComment({ commentId: 2 })] }),
    ]);
    const next = applyCommentRemoval(data, { kind: 'review', commentId: 1 });
    expect(next?.pages[0]?.threads.map(t => t.threadId)).toEqual(['B']);
  });

  it('drops the only thread on the page when its root comment is removed', () => {
    const data = makeData([
      makeThread({ threadId: 'A', comments: [makeComment({ commentId: 1 })] }),
    ]);
    const next = applyCommentRemoval(data, { kind: 'review', commentId: 1 });
    expect(next?.pages[0]?.threads).toEqual([]);
  });

  it('drops the last thread when its root comment is removed', () => {
    const data = makeData([
      makeThread({ threadId: 'A', comments: [makeComment({ commentId: 1 })] }),
      makeThread({ threadId: 'B', comments: [makeComment({ commentId: 2 })] }),
    ]);
    const next = applyCommentRemoval(data, { kind: 'review', commentId: 2 });
    expect(next?.pages[0]?.threads.map(t => t.threadId)).toEqual(['A']);
  });

  it('returns the same reference when no review comment matched', () => {
    const data = makeData([makeThread({ comments: [makeComment({ commentId: 1 })] })]);
    const next = applyCommentRemoval(data, { kind: 'review', commentId: 999 });
    expect(next).toBe(data);
  });

  it('returns the same reference when no conversation comment matched', () => {
    const data: ReviewThreadsInfiniteData = {
      pages: [
        {
          threads: [],
          conversation: [makeConversationComment({ commentId: 900 })],
          nextCursor: null,
        },
      ],
      pageParams: [null],
    };
    const next = applyCommentRemoval(data, { kind: 'conversation', commentId: 999 });
    expect(next).toBe(data);
  });

  it('returns undefined for undefined input', () => {
    expect(applyCommentRemoval(undefined, { kind: 'review', commentId: 1 })).toBeUndefined();
  });
});
