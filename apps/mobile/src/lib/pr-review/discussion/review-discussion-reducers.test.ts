import { describe, expect, it } from 'vitest';

import {
  applyReactionToggle,
  applyResolveToggle,
  findReviewComment,
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
    pages: [{ threads, nextCursor: null }],
    pageParams: [null],
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
        { threads: [makeThread({ threadId: 'A' })], nextCursor: 'p2' },
        { threads: [makeThread({ threadId: 'B' })], nextCursor: null },
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
