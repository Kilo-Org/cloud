import { describe, expect, it, vi } from 'vitest';

import { INFINITE_QUERY_MAX_PAGES } from '@/lib/query/infinite-retention';

import { buildPrReviewDiscussionThreadsQueryOptions } from './use-pr-review-discussion-threads';

// The hook module transitively imports react-native (via
// `@/lib/query/infinite-retention`) and the real tRPC client (via
// `@/lib/trpc`), which the node vitest pipeline cannot transform. The options
// builder itself is pure, so only the module-load chain needs these mocks; no
// hook is mounted. The retention store it reads is covered by
// `conversation-retention.test.ts`.
vi.mock('@/lib/query/schedule-cache-maintenance', () => ({ scheduleCacheMaintenance: vi.fn() }));

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
