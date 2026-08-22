import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  INFINITE_QUERY_MAX_PAGES,
  reconcileFirstPage,
  withInfiniteRetention,
} from '@/lib/query/infinite-retention';

type Item = {
  id: string;
  title: string;
};

type Page = {
  items: Item[];
};

const page = (items: Item[]): Page => ({ items });

describe('withInfiniteRetention', () => {
  it('merges the default maxPages into the options', () => {
    const options = { staleTime: 1000, queryKey: ['sessions'] };
    const result = withInfiniteRetention(options);

    expect(result.maxPages).toBe(INFINITE_QUERY_MAX_PAGES);
    expect(result.staleTime).toBe(1000);
    expect(result.queryKey).toEqual(['sessions']);
  });

  it('uses the explicit maxPages when provided', () => {
    const result = withInfiniteRetention({ staleTime: 1000 }, 10);

    expect(result.maxPages).toBe(10);
  });
});

describe('reconcileFirstPage', () => {
  it('resets a multi-page cached entry to empty pages/pageParams through a prefix key', () => {
    const queryClient = new QueryClient();
    const prefix = ['trpc', 'cliSessionsV2', 'list'];
    const fullKey = [...prefix, { input: { organizationId: 'org-1' } }];
    queryClient.setQueryData(fullKey, {
      pages: [
        page([{ id: 'a', title: 'a' }]),
        page([{ id: 'b', title: 'b' }]),
        page([{ id: 'c', title: 'c' }]),
      ],
      pageParams: [0, 1, 2],
    });

    reconcileFirstPage(queryClient, prefix);

    const data = queryClient.getQueryData(fullKey) as { pages: Page[]; pageParams: unknown[] };
    expect(data.pages).toEqual([]);
    expect(data.pageParams).toEqual([]);
  });

  it('resets to empty even when maxPages has trimmed page one from the front', () => {
    const queryClient = new QueryClient();
    const prefix = ['trpc', 'cliSessionsV2', 'list'];
    const fullKey = [...prefix, { input: { organizationId: 'org-1' } }];
    // After maxPages evicts page 1, `pages[0]` is page 2, not page 1. The
    // reset must not keep that stale head — it empties the list instead.
    queryClient.setQueryData(fullKey, {
      pages: [
        page([{ id: 'b', title: 'b' }]),
        page([{ id: 'c', title: 'c' }]),
        page([{ id: 'd', title: 'd' }]),
      ],
      pageParams: [1, 2, 3],
    });

    reconcileFirstPage(queryClient, prefix);

    const data = queryClient.getQueryData(fullKey) as { pages: Page[]; pageParams: unknown[] };
    expect(data.pages).toEqual([]);
    expect(data.pageParams).toEqual([]);
  });

  it('invalidates the prefix so page one is refetched from initialPageParam', () => {
    const queryClient = new QueryClient();
    const prefix = ['trpc', 'cliSessionsV2', 'list'];
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    queryClient.setQueryData([...prefix, { input: { organizationId: 'org-1' } }], {
      pages: [page([{ id: 'a', title: 'a' }])],
      pageParams: [0],
    });

    reconcileFirstPage(queryClient, prefix);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: prefix });
  });

  it('leaves a non-infinite entry under the same prefix untouched', () => {
    const queryClient = new QueryClient();
    const prefix = ['trpc', 'cliSessionsV2', 'list'];
    const nonInfiniteKey = [...prefix, { input: { organizationId: 'org-2' } }];
    const nonInfinite = { repos: [{ name: 'r' }] };
    queryClient.setQueryData(nonInfiniteKey, nonInfinite);

    reconcileFirstPage(queryClient, prefix);

    expect(queryClient.getQueryData(nonInfiniteKey)).toBe(nonInfinite);
  });

  it('returns synchronously', () => {
    const queryClient = new QueryClient();

    // eslint-disable-next-line typescript-eslint/no-confusing-void-expression -- asserting the void return proves the call needs no await.
    const returned = reconcileFirstPage(queryClient, ['trpc', 'cliSessionsV2', 'list']);
    expect(returned).toBeUndefined();
  });

  it('empties pages and flips fetchStatus to fetching in the same flush on an observed idle query', () => {
    const queryClient = new QueryClient();
    const prefix = ['trpc', 'cliSessionsV2', 'list'];
    const fullKey = [...prefix, { input: { organizationId: 'org-1' } }];
    queryClient.setQueryData(fullKey, {
      pages: [page([{ id: 'a', title: 'a' }])],
      pageParams: [0],
    });

    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: fullKey,
      // eslint-disable-next-line require-await -- the recipe pins an async queryFn for the flush contract; the body needs no await.
      queryFn: async () => page([{ id: 'a', title: 'a' }]),
      initialPageParam: 0,
      getNextPageParam: () => undefined,
      staleTime: Infinity,
      retry: false,
    });
    // eslint-disable-next-line no-empty-function -- a real listener is required to activate the observer; the body is intentionally empty.
    const unsubscribe = observer.subscribe(() => {});

    // The observer must be settled before the blank, or the fetchStatus flip
    // below would be vacuous.
    expect(observer.getCurrentResult().data).toBeDefined();
    expect(observer.getCurrentResult().fetchStatus).toBe('idle');

    reconcileFirstPage(queryClient, prefix);

    const data = queryClient.getQueryData(fullKey) as { pages: Page[] };
    expect(data.pages).toEqual([]);
    expect(queryClient.getQueryState(fullKey)?.fetchStatus).toBe('fetching');

    unsubscribe();
  });
});
