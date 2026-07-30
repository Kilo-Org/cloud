import { describe, expect, it } from 'vitest';

import {
  compareDiscussionListItems,
  type ConversationComment,
  type DiscussionListItem,
  isDiscussionEmpty,
  mergeDiscussionListItems,
  type ReviewComment,
  type ReviewThread,
} from './review-discussion-types';

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, offsetSeconds)).toISOString();
}

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    commentId: 1,
    nodeId: 'C1',
    author: { login: 'alice', avatarUrl: 'https://example.com/a.png' },
    bodyMarkdown: 'hello',
    createdAt: '2024-01-01T00:00:00Z',
    reactions: [{ content: 'THUMBS_UP', count: 2, viewerHasReacted: false }],
    ...overrides,
  };
}

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
    comments: [makeComment()],
    ...overrides,
  };
}

function makeConversation(overrides: Partial<ConversationComment> = {}): ConversationComment {
  return makeComment({ nodeId: 'IC1', commentId: 100, ...overrides });
}

function keysOf(items: readonly DiscussionListItem[]): string[] {
  return items.map(item =>
    item.kind === 'thread' ? `thread:${item.thread.threadId}` : `comment:${item.comment.nodeId}`
  );
}

function threadAt(
  threadId: string,
  firstAt: string,
  extraComments: ReviewComment[] = []
): ReviewThread {
  return makeThread({
    threadId,
    comments: [makeComment({ nodeId: `${threadId}-1`, createdAt: firstAt }), ...extraComments],
  });
}

describe('mergeDiscussionListItems', () => {
  // A2.1: thread A @ T+1 (reply T+5 nested); conv T+2/T+3; thread B @ T+4; conv T+6.
  it('merges threads and conversation into one ascending list (A2.1)', () => {
    const threadA = threadAt('A', at(1), [
      makeComment({ nodeId: 'A2', commentId: 2, createdAt: at(5) }),
    ]);
    const threadB = threadAt('B', at(4));
    const ic2 = makeConversation({ nodeId: 'IC2', createdAt: at(2) });
    const ic3 = makeConversation({ nodeId: 'IC3', createdAt: at(3) });
    const ic6 = makeConversation({ nodeId: 'IC6', createdAt: at(6) });

    // Scrambled input so page-arrival order cannot leak through.
    const merged = mergeDiscussionListItems([threadB, threadA], [ic6, ic2, ic3]);
    expect(keysOf(merged)).toEqual([
      'thread:A',
      'comment:IC2',
      'comment:IC3',
      'thread:B',
      'comment:IC6',
    ]);
    // Thread A once; T+5 reply stays nested (not an outer row).
    const aRows = merged.filter(i => i.kind === 'thread' && i.thread.threadId === 'A');
    expect(aRows).toHaveLength(1);
    const aOnly = aRows[0];
    expect(aOnly?.kind === 'thread' ? aOnly.thread.comments.map(c => c.nodeId) : []).toEqual([
      'A-1',
      'A2',
    ]);
  });

  it('renders conversation-only PRs (A2.6)', () => {
    const merged = mergeDiscussionListItems(
      [],
      [
        makeConversation({ nodeId: 'IC1', createdAt: at(2) }),
        makeConversation({ nodeId: 'IC0', createdAt: at(1) }),
      ]
    );
    expect(keysOf(merged)).toEqual(['comment:IC0', 'comment:IC1']);
  });

  it('keeps zero-comment threads after timestamped items (A2.2)', () => {
    const empty = makeThread({ threadId: 'empty', comments: [] });
    const timed = threadAt('timed', at(1));
    const conv = makeConversation({ nodeId: 'IC', createdAt: at(2) });
    expect(keysOf(mergeDiscussionListItems([empty, timed], [conv]))).toEqual([
      'thread:timed',
      'comment:IC',
      'thread:empty',
    ]);
  });

  it('sorts unparseable first-comment timestamps last (A2.2)', () => {
    const bad = makeThread({
      threadId: 'bad',
      comments: [makeComment({ nodeId: 'badC', createdAt: 'not-a-date' })],
    });
    const good = threadAt('good', at(1));
    expect(keysOf(mergeDiscussionListItems([bad, good], []))).toEqual([
      'thread:good',
      'thread:bad',
    ]);
  });

  it('on equal createdAt, threads before conversation comments (A2.2)', () => {
    const stamp = at(10);
    expect(
      keysOf(
        mergeDiscussionListItems(
          [threadAt('T', stamp)],
          [makeConversation({ nodeId: 'IC', createdAt: stamp })]
        )
      )
    ).toEqual(['thread:T', 'comment:IC']);
  });

  it('on equal createdAt and kind, ties break on identity (A2.2)', () => {
    const stamp = at(10);
    expect(
      keysOf(
        mergeDiscussionListItems(
          [threadAt('B', stamp), threadAt('A', stamp)],
          [
            makeConversation({ nodeId: 'Z', createdAt: stamp }),
            makeConversation({ nodeId: 'Y', createdAt: stamp }),
          ]
        )
      )
    ).toEqual(['thread:A', 'thread:B', 'comment:Y', 'comment:Z']);
  });

  it('full re-sort ignores input page order (R4)', () => {
    // "Load more" can deliver an older thread after a newer one.
    expect(
      keysOf(mergeDiscussionListItems([threadAt('late', at(9)), threadAt('early', at(1))], []))
    ).toEqual(['thread:early', 'thread:late']);
  });
});

describe('compareDiscussionListItems', () => {
  it('is antisymmetric on equal items', () => {
    const item: DiscussionListItem = { kind: 'thread', thread: makeThread({ threadId: 'X' }) };
    expect(compareDiscussionListItems(item, item)).toBe(0);
  });
});

describe('isDiscussionEmpty', () => {
  it('is true only when both kinds are absent (A2.5)', () => {
    expect(isDiscussionEmpty([], [])).toBe(true);
    expect(isDiscussionEmpty([makeThread()], [])).toBe(false);
    expect(isDiscussionEmpty([], [makeConversation()])).toBe(false);
    expect(isDiscussionEmpty([makeThread()], [makeConversation()])).toBe(false);
  });
});
