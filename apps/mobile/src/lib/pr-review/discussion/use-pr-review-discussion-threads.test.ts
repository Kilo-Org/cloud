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
    // First mount: the first page holds the conversation.
    expect(retainConversationAcrossMounts(key, [{ conversation: [comment] }])).toEqual([comment]);
    // Remount over the trimmed cache: pages[0] is a later page with [].
    expect(retainConversationAcrossMounts(key, [{ conversation: [] }])).toEqual([comment]);
  });

  it('does not leak the conversation across different PRs', () => {
    retainConversationAcrossMounts('octocat/hello#1', [{ conversation: [comment] }]);
    // A different PR has never retained anything, so it stays empty.
    expect(retainConversationAcrossMounts('octocat/hello#2', [{ conversation: [] }])).toEqual([]);
  });
});
