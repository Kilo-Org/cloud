import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseTimestamp } from '@/lib/utils';

import { mergeDiscussionListItemsBySortKey } from './merge-discussion-list-items';
import {
  type ConversationComment,
  type DiscussionListItem,
  mergeDiscussionListItems,
  type ReviewComment,
  type ReviewThread,
} from './review-discussion-types';

// Count every parse while delegating to the real implementation. The whole
// point of the decorated merge is that no comparator call parses a timestamp.
vi.mock('@/lib/utils', async importOriginal => {
  const actual = await importOriginal<{ parseTimestamp: (value: string) => Date }>();
  return { ...actual, parseTimestamp: vi.fn(actual.parseTimestamp) };
});

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

function threadAt(threadId: string, firstAt: string): ReviewThread {
  return makeThread({
    threadId,
    comments: [makeComment({ nodeId: `${threadId}-1`, createdAt: firstAt })],
  });
}

function keysOf(items: readonly DiscussionListItem[]): string[] {
  return items.map(item =>
    item.kind === 'thread' ? `thread:${item.thread.threadId}` : `comment:${item.comment.nodeId}`
  );
}

const parseTimestampMock = vi.mocked(parseTimestamp);

describe('mergeDiscussionListItemsBySortKey', () => {
  beforeEach(() => {
    parseTimestampMock.mockClear();
  });

  it('orders exactly like mergeDiscussionListItems for a tie and a missing timestamp', () => {
    const tieStamp = at(3);
    const threads = [
      threadAt('T1', tieStamp),
      threadAt('T2', at(1)),
      makeThread({ threadId: 'T3', comments: [makeComment({ nodeId: 'T3-1', createdAt: '' })] }),
    ];
    const conversation: ConversationComment[] = [
      makeConversation({ nodeId: 'IC-tie', createdAt: tieStamp }),
      makeConversation({ nodeId: 'IC-late', createdAt: at(9) }),
    ];

    const bySortKey = mergeDiscussionListItemsBySortKey(threads, conversation);
    const reference = mergeDiscussionListItems(threads, conversation);

    // Equal createdAt (thread vs conversation) breaks to the thread; the empty
    // timestamp sorts last.
    expect(keysOf(bySortKey)).toEqual([
      'thread:T2',
      'thread:T1',
      'comment:IC-tie',
      'comment:IC-late',
      'thread:T3',
    ]);
    expect(keysOf(bySortKey)).toEqual(keysOf(reference));
  });

  it('parses each item with a timestamp once per merge, not once per comparison', () => {
    const threads = [
      threadAt('A', at(1)),
      threadAt('B', at(3)),
      // No comments → no timestamp to parse.
      makeThread({ threadId: 'C', comments: [] }),
    ];
    const conversation: ConversationComment[] = [
      makeConversation({ nodeId: 'IC-d', createdAt: at(2) }),
      // Empty timestamp → not parsed.
      makeConversation({ nodeId: 'IC-e', createdAt: '' }),
    ];

    const merged = mergeDiscussionListItemsBySortKey(threads, conversation);

    expect(keysOf(merged)).toEqual([
      'thread:A',
      'comment:IC-d',
      'thread:B',
      'thread:C',
      'comment:IC-e',
    ]);
    // One parse per timestamped item, in decoration (input) order; the
    // timestamp-less items are never parsed.
    expect(parseTimestampMock.mock.calls.map(([raw]) => raw)).toEqual([at(1), at(3), at(2)]);
    expect(parseTimestampMock).toHaveBeenCalledTimes(3);
  });
});
