import { describe, expect, it, vi } from 'vitest';

import { INFINITE_QUERY_MAX_PAGES } from '@/lib/query/infinite-retention';

import { type ConversationComment } from './review-discussion-types';
import {
  buildPrReviewDiscussionThreadsQueryOptions,
  retainConversation,
  retainConversationAcrossMounts,
} from './use-pr-review-discussion-threads';

// The hook module transitively imports react-native (via
// `@/lib/query/infinite-retention`) and the real tRPC client (via
// `@/lib/trpc`), which the node vitest pipeline cannot transform. The options
// builder itself is pure, so only the module-load chain needs these mocks; no
// hook is mounted.
vi.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: vi.fn(),
}));

function createTrpcStub(infiniteQueryOptions: unknown) {
  const stub = { githubPrReview: { listReviewThreads: { infiniteQueryOptions } } };
  return stub as never;
}

describe('buildPrReviewDiscussionThreadsQueryOptions', () => {
  it('carries a numeric maxPages', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildPrReviewDiscussionThreadsQueryOptions(
      createTrpcStub(infiniteQueryOptions),
      {
        owner: 'octocat',
        repo: 'hello',
        number: 1,
      }
    );

    expect(result.maxPages).toBe(INFINITE_QUERY_MAX_PAGES);
  });
});

describe('retainConversation (retention-safe conversation)', () => {
  const comment = { id: 'c1' };

  it('returns the first-page conversation when it is present', () => {
    const pages = [{ conversation: [comment] }];
    expect(retainConversation(pages, [])).toEqual([comment]);
  });

  it('keeps the retained conversation after the trim drops the first page', () => {
    const retained = [comment];
    // After the retention trim, pages[0] is a later page with conversation: [].
    const trimmedPages = [{ conversation: [] }];
    expect(retainConversation(trimmedPages, retained)).toBe(retained);
  });

  it('falls back to an empty list when nothing was ever retained', () => {
    expect(retainConversation(undefined, [])).toEqual([]);
  });
});

describe('retainConversationAcrossMounts (remount survival)', () => {
  const comment = { id: 'c1' } as unknown as ConversationComment;

  it('keeps the conversation after a remount over the trimmed cache', () => {
    const key = 'octocat/hello#1';
    // First mount: page one is loaded and holds the conversation.
    expect(retainConversationAcrossMounts(key, [{ conversation: [comment] }], true)).toEqual([
      comment,
    ]);
    // Remount over the trimmed cache: pages[0] is a later page with [], so the
    // first page is no longer loaded and the retained copy is the source.
    expect(retainConversationAcrossMounts(key, [{ conversation: [] }], false)).toEqual([comment]);
  });

  it('does not leak the conversation across different PRs', () => {
    retainConversationAcrossMounts('octocat/hello#1', [{ conversation: [comment] }], true);
    // A different PR has never retained anything, so it stays empty.
    expect(
      retainConversationAcrossMounts('octocat/hello#2', [{ conversation: [] }], false)
    ).toEqual([]);
  });

  it('empties the conversation when the live first page loads with none (delete of the last comment)', () => {
    const key = 'octocat/hello#1';
    // Page one loaded with the comment.
    expect(retainConversationAcrossMounts(key, [{ conversation: [comment] }], true)).toEqual([
      comment,
    ]);
    // Deleting the last conversation comment leaves the live first page loaded
    // and empty: the empty truth wins, so the Discussion reaches its empty
    // state instead of resurrecting the deleted row.
    expect(retainConversationAcrossMounts(key, [{ conversation: [] }], true)).toEqual([]);
    // A later evicted read of the same key still returns that empty truth.
    expect(retainConversationAcrossMounts(key, [{ conversation: [] }], false)).toEqual([]);
  });
});
