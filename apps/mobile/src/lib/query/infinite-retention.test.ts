import { QueryClient } from '@tanstack/react-query';
import { InteractionManager } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import {
  INFINITE_QUERY_MAX_PAGES,
  reconcileFirstPage,
  scheduleCacheMaintenance,
  withInfiniteRetention,
} from '@/lib/query/infinite-retention';

vi.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: vi.fn() },
}));

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
  it('trims to page one through a prefix key when the cached key carries an extra input segment', () => {
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
    expect(data.pages).toHaveLength(1);
    expect(data.pageParams).toHaveLength(1);
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
});

describe('scheduleCacheMaintenance', () => {
  it('runs the callback through InteractionManager.runAfterInteractions', () => {
    const run = vi.fn<() => void>();

    scheduleCacheMaintenance(run);

    // eslint-disable-next-line typescript-eslint/unbound-method, typescript-eslint/no-deprecated -- the mock is a plain vi.fn() with no `this`, and runAfterInteractions is the documented deferral API.
    expect(InteractionManager.runAfterInteractions).toHaveBeenCalledWith(run);
  });
});
