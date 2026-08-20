/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  type FetchToCompletionResult,
  useFetchToCompletion,
} from '@/lib/pr-review/diff/pr-review-file-list-state';
import { renderWithProviders } from '@/test/render-with-providers';

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubPrReview: {
      listFiles: {
        infiniteQueryOptions: () => ({}),
      },
    },
  }),
}));

vi.mock('@/lib/pr-review/viewed-files', () => ({
  getViewedFiles: vi.fn(),
  toggleViewedFile: vi.fn(),
}));

type QueryStub = Parameters<typeof useFetchToCompletion>[0];

function Probe({
  query,
  holder,
}: {
  query: QueryStub;
  holder: { current: FetchToCompletionResult | null };
}) {
  holder.current = useFetchToCompletion(query, 200);
  return null;
}

async function mountProbe(query: QueryStub): Promise<{ current: FetchToCompletionResult | null }> {
  const holder: { current: FetchToCompletionResult | null } = { current: null };
  await renderWithProviders(createElement(Probe, { query, holder }));
  return holder;
}

function current(holder: { current: FetchToCompletionResult | null }): FetchToCompletionResult {
  const result = holder.current;
  if (!result) {
    throw new Error('probe did not render');
  }
  return result;
}

describe('useFetchToCompletion resolved error', () => {
  it('stops after one request when fetchNextPage resolves with an error and hasNextPage stays true', async () => {
    const pageError = new Error('later page failed');
    const fetchNextPage = vi.fn(async () => {
      await Promise.resolve();
      return {
        data: { pages: [{ files: [{ path: 'a.ts' }] }] },
        hasNextPage: true,
        error: pageError,
      };
    });
    const query = {
      isFetching: false,
      hasNextPage: true,
      fetchNextPage,
      data: { pages: [{ files: [{ path: 'a.ts' }] }] },
    } as unknown as QueryStub;

    const holder = await mountProbe(query);
    await act(async () => {
      await current(holder).run();
    });

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    expect(current(holder).error).toBe(pageError);
    expect(current(holder).isRunning).toBe(false);
  });
});
