import { describe, expect, it, vi } from 'vitest';

import { buildPrReviewFileListQueryOptions } from './pr-review-file-list-state';

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
  // The literal ceiling, not the constant: this is the documented server page
  // cap (60 pages × 50/page = 3,000 files, the same as the truncation banner).
  // Comparing the builder's output to the same constant it imports could
  // never catch the constant drifting to an unsafe value.
  it('caps retention at the server page ceiling of 60', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildPrReviewFileListQueryOptions(createTrpcStub(infiniteQueryOptions), {
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      enabled: true,
    });

    expect(result.maxPages).toBe(60);
  });
});
