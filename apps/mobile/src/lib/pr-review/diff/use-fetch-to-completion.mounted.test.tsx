import { createElement, useState } from 'react';
import { act } from '@/test/renderer';
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

const PAGE = { pages: [{ files: [{ path: 'a.ts' }] }] };

function stubQuery(overrides: Record<string, unknown>): QueryStub {
  return {
    isFetching: false,
    hasNextPage: true,
    data: PAGE,
    dataUpdatedAt: 100,
    fetchNextPage: vi.fn(),
    ...overrides,
  } as unknown as QueryStub;
}

function Probe({
  queryRef,
  holder,
  rerender,
}: {
  queryRef: { current: QueryStub };
  holder: { current: FetchToCompletionResult | null };
  rerender: { current: () => void };
}) {
  const [, setRenderCount] = useState(0);
  rerender.current = () => {
    setRenderCount(count => count + 1);
  };
  holder.current = useFetchToCompletion(queryRef.current, 200);
  return null;
}

async function mountProbe(overrides: Record<string, unknown>) {
  const holder: { current: FetchToCompletionResult | null } = { current: null };
  const queryRef = { current: stubQuery(overrides) };
  const rerender: { current: () => void } = { current: () => undefined };
  await renderWithProviders(createElement(Probe, { queryRef, holder, rerender }));
  return {
    holder,
    update: (parts: Record<string, unknown>): void => {
      queryRef.current = stubQuery({ ...overrides, ...parts });
      act(() => {
        rerender.current();
      });
    },
  };
}

function current(holder: { current: FetchToCompletionResult | null }): FetchToCompletionResult {
  const result = holder.current;
  if (!result) {
    throw new Error('probe did not render');
  }
  return result;
}

describe('useFetchToCompletion failure phase', () => {
  it('retains the failure while the query data version is unchanged', async () => {
    const pageError = new Error('later page failed');
    const fetchNextPage = vi.fn(async () => {
      await Promise.resolve();
      return { data: PAGE, hasNextPage: true, error: pageError, dataUpdatedAt: 100 };
    });
    const { holder, update } = await mountProbe({ fetchNextPage });
    await act(async () => {
      await current(holder).run();
    });

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    expect(current(holder).failure).toMatchObject({ kind: 'load-all-failed', at: 100 });
    expect(current(holder).feedback.status).toBe('failed');

    // Same data version: the failure is still the truth about this list.
    update({ dataUpdatedAt: 100 });

    expect(current(holder).failure).not.toBeNull();
  });

  it('retires the failure once a page lands beyond the version it failed at', async () => {
    const pageError = new Error('later page failed');
    const fetchNextPage = vi.fn(async () => {
      await Promise.resolve();
      return { data: PAGE, hasNextPage: true, error: pageError, dataUpdatedAt: 100 };
    });
    const { holder, update } = await mountProbe({ fetchNextPage });
    await act(async () => {
      await current(holder).run();
    });
    expect(current(holder).failure).not.toBeNull();

    update({ dataUpdatedAt: 200 });

    expect(current(holder).failure).toBeNull();
    expect(current(holder).feedback.status).toBe('idle');
  });

  it('admits one run at a time: a second run while the first is pending issues one request', async () => {
    const gate = Promise.withResolvers<undefined>();
    const fetchNextPage = vi.fn(async () => {
      await gate.promise;
      return { data: PAGE, hasNextPage: false, error: null, dataUpdatedAt: 100 };
    });
    const { holder } = await mountProbe({ fetchNextPage });
    act(() => {
      void current(holder).run();
    });
    expect(current(holder).feedback.status).toBe('pending');

    await act(async () => {
      await current(holder).run();
    });
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    gate.resolve(undefined);
    await act(async () => {
      await Promise.resolve();
    });
    expect(current(holder).feedback.status).toBe('succeeded');
  });
});
