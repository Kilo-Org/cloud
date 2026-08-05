/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as fixed-part-row.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_HISTORY_AUTOLOAD_PAGES,
  shouldBackfillHistoryAfterActiveExclusion,
} from './session-list-backfill';
import { useHistoryBackfill } from './use-history-backfill';

type SelectorInputs = Parameters<typeof shouldBackfillHistoryAfterActiveExclusion>[0];
type R = TestRenderer.ReactTestRenderer;

// Every selector gate green: sections emptied by active exclusion, more stored
// history exists, nothing in flight, below the page bound.
function greenInputs(overrides: Partial<SelectorInputs> = {}): SelectorInputs {
  return {
    hasHistoryContent: false,
    hasStoredSessions: true,
    hasMoreHistory: true,
    isFetchingNextPage: false,
    isFetching: false,
    isSearching: false,
    isLoading: false,
    isError: false,
    loadedPageCount: 1,
    ...overrides,
  };
}

// Probe that runs the real selector + hook wiring on every render and records
// `fetchNextPage` calls through the mock, so the mounted test proves the effect
// fires once per qualifying transition and honors the selector's gates.
function BackfillProbe({
  fetchNextPage,
  ...inputs
}: SelectorInputs & { fetchNextPage: () => Promise<unknown> }) {
  const shouldBackfill = shouldBackfillHistoryAfterActiveExclusion(inputs);
  useHistoryBackfill({ shouldBackfill, fetchNextPage });
  return null;
}

async function mountProbe(
  fetchNextPage: () => Promise<unknown>,
  inputs: SelectorInputs
): Promise<R> {
  const ref: { current: R | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(BackfillProbe, { ...inputs, fetchNextPage }));
  });
  const created = ref.current;
  if (!created) {
    throw new Error('renderer was not created');
  }
  return created;
}

async function updateProbe(
  renderer: R,
  fetchNextPage: () => Promise<unknown>,
  inputs: SelectorInputs
): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.update(createElement(BackfillProbe, { ...inputs, fetchNextPage }));
  });
}

describe('useHistoryBackfill mounted', () => {
  it('fetches the next page exactly once on the false-to-true transition', async () => {
    const fetchNextPage = vi.fn();

    // Blocked on mount (list still loading): no automatic fetch.
    const renderer = await mountProbe(fetchNextPage, greenInputs({ isLoading: true }));
    expect(fetchNextPage).not.toHaveBeenCalled();

    // Loading clears: the selector flips to true and the effect fetches once.
    await updateProbe(renderer, fetchNextPage, greenInputs());
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    // A re-render that keeps the selector true is not a qualifying transition.
    await updateProbe(renderer, fetchNextPage, greenInputs());
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('stops backfill once history content is visible again', async () => {
    const fetchNextPage = vi.fn();
    const renderer = await mountProbe(fetchNextPage, greenInputs());
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    // A rendered section appears: the selector flips false, no further fetch.
    await updateProbe(renderer, fetchNextPage, greenInputs({ hasHistoryContent: true }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    // Content stays visible across later re-renders: still no fetch.
    await updateProbe(renderer, fetchNextPage, greenInputs({ hasHistoryContent: true }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('stops automatic fetches at the loaded-page bound across fetch cycles', async () => {
    const fetchNextPage = vi.fn();
    const renderer = await mountProbe(fetchNextPage, greenInputs());
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    // Fetch in flight: the selector blocks until the page lands.
    await updateProbe(renderer, fetchNextPage, greenInputs({ isFetchingNextPage: true }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    // Page 2 lands below the bound: next qualifying transition fetches.
    await updateProbe(renderer, fetchNextPage, greenInputs({ loadedPageCount: 2 }));
    expect(fetchNextPage).toHaveBeenCalledTimes(2);

    await updateProbe(renderer, fetchNextPage, greenInputs({ isFetchingNextPage: true }));
    expect(fetchNextPage).toHaveBeenCalledTimes(2);

    // Page 3 lands at the bound: the selector stays false, no third fetch.
    await updateProbe(
      renderer,
      fetchNextPage,
      greenInputs({ loadedPageCount: MAX_HISTORY_AUTOLOAD_PAGES })
    );
    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });

  it('does not backfill while a stored fetch is in flight', async () => {
    const fetchNextPage = vi.fn();

    // Every gate green except a stored refetch in flight: no automatic fetch.
    const renderer = await mountProbe(fetchNextPage, greenInputs({ isFetching: true }));
    expect(fetchNextPage).not.toHaveBeenCalled();

    // The refetch settles: the false-to-true transition fetches exactly once.
    await updateProbe(renderer, fetchNextPage, greenInputs());
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
