import { describe, expect, it, vi } from 'vitest';

import { buildPrReviewFileListQueryOptions } from './pr-review-file-list-state';
import { PR_REVIEW_MAX_PAGES } from './pr-review-file-types';

// The hook module transitively imports react-native (via
// `@/lib/query/infinite-retention` and the viewed-files store) and the real
// tRPC client (via `@/lib/trpc`), which the node vitest pipeline cannot
// transform. The options builder itself is pure, so only the module-load chain
// needs these mocks; no hook is mounted.
vi.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: vi.fn(),
}));

vi.mock('@/lib/pr-review/viewed-files', () => ({
  getViewedFiles: vi.fn(),
  toggleViewedFile: vi.fn(),
}));

function createTrpcStub(infiniteQueryOptions: unknown) {
  const stub = { githubPrReview: { listFiles: { infiniteQueryOptions } } };
  return stub as never;
}

describe('buildPrReviewFileListQueryOptions', () => {
  it('carries a numeric maxPages bound to PR_REVIEW_MAX_PAGES', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildPrReviewFileListQueryOptions(createTrpcStub(infiniteQueryOptions), {
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      enabled: true,
    });

    expect(result.maxPages).toBe(PR_REVIEW_MAX_PAGES);
  });
});
