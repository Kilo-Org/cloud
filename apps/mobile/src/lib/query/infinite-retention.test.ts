import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  hasRetentionBudget,
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

describe('hasRetentionBudget', () => {
  it('allows a page while the retained count is below the bound', () => {
    expect(hasRetentionBudget(0, 5)).toBe(true);
    expect(hasRetentionBudget(4, 5)).toBe(true);
  });

  it('refuses a page at or past the bound', () => {
    // At the bound the next page would push the cache past `maxPages`, and the
    // forward-fetch trim drops index 0 — page one, the newest page.
    expect(hasRetentionBudget(5, 5)).toBe(false);
    expect(hasRetentionBudget(6, 5)).toBe(false);
  });

  it('defaults to the shared retention constant', () => {
    expect(hasRetentionBudget(INFINITE_QUERY_MAX_PAGES - 1)).toBe(true);
    expect(hasRetentionBudget(INFINITE_QUERY_MAX_PAGES)).toBe(false);
  });
});

describe('reconcileFirstPage', () => {
  const prefix = ['trpc', 'cliSessionsV2', 'list'];
  const fullKey = [...prefix, { input: { organizationId: 'org-1' } }];

  it('keeps the retained pages while page one refetches, then replaces them with page one', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A holder rather than a captured `let`: the recipe assigns `release` from
    // inside the query function, and only a property read is re-checked there.
    const gate: { release?: () => void } = {};
    let hold = false;
    const calls: number[] = [];
    // eslint-disable-next-line require-await -- the held fetch is the point: the recipe resolves it from the test.
    const queryFn = async ({ pageParam }: { pageParam: number }): Promise<Page> => {
      calls.push(pageParam);
      if (hold) {
        await new Promise<void>(resolve => {
          gate.release = resolve;
        });
      }
      return page([{ id: `p${pageParam}`, title: `p${pageParam}` }]);
    };
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: fullKey,
      queryFn,
      initialPageParam: 0,
      getNextPageParam: (_lastPage: Page, _pages: Page[], lastPageParam: number) =>
        lastPageParam + 1,
    });
    // eslint-disable-next-line no-empty-function -- a real listener is required to activate the observer; the body is intentionally empty.
    const unsubscribe = observer.subscribe(() => {});

    await observer.refetch();
    await observer.fetchNextPage();
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().data?.pages).toHaveLength(3);

    calls.length = 0;
    hold = true;
    const reconcile = reconcileFirstPage(queryClient, prefix);
    await vi.waitFor(() => {
      expect(gate.release).toBeTypeOf('function');
    });

    // The reader's rows are still on screen while page one is in flight.
    expect(observer.getCurrentResult().data?.pages).toHaveLength(3);
    expect(queryClient.getQueryState(fullKey)?.fetchStatus).toBe('fetching');

    gate.release?.();
    await reconcile;

    // One request, from page one, replacing the pages only when it arrives.
    expect(calls).toEqual([0]);
    expect(observer.getCurrentResult().data).toEqual({
      pages: [page([{ id: 'p0', title: 'p0' }])],
      pageParams: [0],
    });

    unsubscribe();
  });

  it('re-anchors a trimmed start cursor so the refetch is page one, not the oldest retained page', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: number[] = [];
    // eslint-disable-next-line require-await -- the recipe pins an async queryFn; the body needs no await.
    const queryFn = async ({ pageParam }: { pageParam: number }): Promise<Page> => {
      calls.push(pageParam);
      return page([{ id: `p${pageParam}`, title: `p${pageParam}` }]);
    };
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: fullKey,
      queryFn,
      initialPageParam: 0,
      getNextPageParam: (_lastPage: Page, _pages: Page[], lastPageParam: number) =>
        lastPageParam + 1,
      maxPages: 2,
    });
    // eslint-disable-next-line no-empty-function -- a real listener is required to activate the observer; the body is intentionally empty.
    const unsubscribe = observer.subscribe(() => {});

    await observer.refetch();
    await observer.fetchNextPage();
    // `maxPages: 2` evicts page one, so index 0 is now page two's cursor.
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().data?.pageParams).toEqual([1, 2]);

    calls.length = 0;
    await reconcileFirstPage(queryClient, prefix);

    expect(calls).toEqual([0]);
    expect(observer.getCurrentResult().data).toEqual({
      pages: [page([{ id: 'p0', title: 'p0' }])],
      pageParams: [0],
    });

    unsubscribe();
  });

  it('keeps the rows when the page-one refetch fails', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let fail = false;
    // eslint-disable-next-line require-await -- the recipe pins an async queryFn that fails on demand.
    const queryFn = async ({ pageParam }: { pageParam: number }): Promise<Page> => {
      if (fail) {
        throw new Error('offline');
      }
      return page([{ id: `p${pageParam}`, title: `p${pageParam}` }]);
    };
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: fullKey,
      queryFn,
      initialPageParam: 0,
      getNextPageParam: (_lastPage: Page, _pages: Page[], lastPageParam: number) =>
        lastPageParam + 1,
    });
    // eslint-disable-next-line no-empty-function -- a real listener is required to activate the observer; the body is intentionally empty.
    const unsubscribe = observer.subscribe(() => {});

    await observer.refetch();
    await observer.fetchNextPage();
    const before = observer.getCurrentResult().data;

    fail = true;
    await reconcileFirstPage(queryClient, prefix);

    // A failed refresh is not an empty list: the rows and their cursors stay.
    expect(observer.getCurrentResult().data).toEqual(before);
    expect(queryClient.getQueryState(fullKey)?.isInvalidated).toBe(true);

    unsubscribe();
  });

  it('drops the pages of an entry no list is showing and fetches nothing', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: number[] = [];
    // eslint-disable-next-line require-await -- the recipe pins an async queryFn; the body needs no await.
    const queryFn = async ({ pageParam }: { pageParam: number }): Promise<Page> => {
      calls.push(pageParam);
      return page([{ id: `p${pageParam}`, title: `p${pageParam}` }]);
    };
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: fullKey,
      queryFn,
      initialPageParam: 0,
      getNextPageParam: () => undefined,
    });
    queryClient.setQueryData(fullKey, {
      pages: [page([{ id: 'a', title: 'a' }])],
      pageParams: [0],
    });

    await reconcileFirstPage(queryClient, prefix);

    // Nothing renders these rows, so they are dropped: the next mount fetches
    // page one instead of fanning out over every retained page.
    expect(calls).toEqual([]);
    expect(queryClient.getQueryState(fullKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(fullKey)).toEqual({ pages: [], pageParams: [] });
    observer.destroy();
  });

  it('does not run a read its observer has not enabled', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: number[] = [];
    // eslint-disable-next-line require-await -- the recipe pins an async queryFn; the body needs no await.
    const queryFn = async ({ pageParam }: { pageParam: number }): Promise<Page> => {
      calls.push(pageParam);
      return page([{ id: `p${pageParam}`, title: `p${pageParam}` }]);
    };
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: fullKey,
      queryFn,
      initialPageParam: 0,
      getNextPageParam: (_lastPage: Page, _pages: Page[], lastPageParam: number) =>
        lastPageParam + 1,
      // The screen waits on filters or an organization before it reads.
      enabled: false,
    });
    queryClient.setQueryData(fullKey, {
      pages: [page([{ id: 'a', title: 'a' }])],
      pageParams: [0],
    });
    // eslint-disable-next-line no-empty-function -- a real listener is required to activate the observer; the body is intentionally empty.
    const unsubscribe = observer.subscribe(() => {});

    await reconcileFirstPage(queryClient, prefix);

    // `query.fetch` ignores `enabled`, so the reconcile has to respect it: the
    // app has not loaded what the read depends on yet.
    expect(calls).toEqual([]);
    // The rows stay, because the mounted list is only waiting to enable.
    expect(queryClient.getQueryData(fullKey)).toEqual({
      pages: [page([{ id: 'a', title: 'a' }])],
      pageParams: [0],
    });

    unsubscribe();
  });

  it('marks the prefix stale without refetching it', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    queryClient.setQueryData(fullKey, {
      pages: [page([{ id: 'a', title: 'a' }])],
      pageParams: [0],
    });

    await reconcileFirstPage(queryClient, prefix);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: prefix, refetchType: 'none' });
  });

  it('leaves a non-infinite entry under the same prefix untouched', async () => {
    const queryClient = new QueryClient();
    const nonInfiniteKey = [...prefix, { input: { organizationId: 'org-2' } }];
    const nonInfinite = { repos: [{ name: 'r' }] };
    queryClient.setQueryData(nonInfiniteKey, nonInfinite);

    await reconcileFirstPage(queryClient, prefix);

    expect(queryClient.getQueryData(nonInfiniteKey)).toBe(nonInfinite);
  });

  it('resolves when nothing is cached under the prefix', async () => {
    const queryClient = new QueryClient();

    await expect(reconcileFirstPage(queryClient, prefix)).resolves.toBeUndefined();
  });
});

describe('infinite-query refetch fan-out through withInfiniteRetention', () => {
  it('re-requests every retained page, so maxPages bounds a single refetch', async () => {
    const queryClient = new QueryClient();
    let calls = 0;
    const baseOptions = {
      queryKey: ['refetch-fanout'],
      // eslint-disable-next-line require-await -- the recipe pins an async queryFn; the body needs no await.
      queryFn: async ({ pageParam }: { pageParam: number }) => {
        calls += 1;
        return page([{ id: String(pageParam), title: 'x' }]);
      },
      initialPageParam: 0,
      getNextPageParam: (_lastPage: Page, pages: Page[]) => pages.length,
      staleTime: Infinity,
      retry: false,
    } as const;
    // The observer options come from this module's own helper, so the
    // retention bound the app actually uses is what this test exercises.
    const observer = new InfiniteQueryObserver(queryClient, {
      ...baseOptions,
      ...withInfiniteRetention(baseOptions, 3),
    });
    // eslint-disable-next-line no-empty-function -- a real listener is required to activate the observer; the body is intentionally empty.
    const unsubscribe = observer.subscribe(() => {});

    await observer.refetch();
    for (let loaded = 1; loaded < 3; loaded += 1) {
      // eslint-disable-next-line no-await-in-loop -- each page's cursor is the previous page's result.
      await observer.fetchNextPage();
    }
    expect(observer.getCurrentResult().data?.pages).toHaveLength(3);

    // A 4th page exists; the cap of 3 must evict the oldest page instead of
    // retaining it. Without the helper's maxPages, the pages array would grow
    // to 4 and the refetch below would fan out 4 requests.
    // eslint-disable-next-line no-await-in-loop -- the cursor chain continues from page 3.
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().data?.pages).toHaveLength(3);

    calls = 0;
    await observer.refetch();

    // `refetch()` walks every page still in the cache: a focus/foreground
    // refetch of the session history issues one request per retained page, so
    // `maxPages` is the fan-out cap, not just a memory bound.
    expect(calls).toBe(3);

    unsubscribe();
  });
});
