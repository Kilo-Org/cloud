// File-list query + viewed-files sync + fetch-to-completion control for
// the PR review Files tab. Centralizes the tRPC `listFiles` infinite
// query and the viewed-files store so the list component can stay
// focused on rendering.
//
// The list tab has two distinct loading dimensions:
//   1. Page-level: a single `listFiles` page can fail mid-stream. The
//      caller renders a retry row (handled inside the FlashList) and
//      the query's `refetch` re-fetches just the failed page.
//   2. Tab-level terminal: a `NOT_FOUND` / `FORBIDDEN` /
//      `PRECONDITION_FAILED` on the first page means the whole tab
//      is dead — there's no point rendering a list skeleton with a
//      retry. The Files tab treats this as a terminal state (no CTA
//      for `permission`, an install CTA for `not-found`).
//
// `usePrReviewFileListQuery` is the only hook the list component
// needs; it returns a `useInfiniteQuery` result plus a `status` field
// that already classifies the error so the list can short-circuit
// to the right terminal state.

import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { classifyPrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';
import { PR_REVIEW_MAX_PAGES } from '@/lib/pr-review/diff/pr-review-file-types';
import { getViewedFiles, toggleViewedFile } from '@/lib/pr-review/viewed-files';
import { useTRPC } from '@/lib/trpc';

export function usePrReviewFileListQuery(args: {
  owner: string;
  repo: string;
  number: number;
  enabled: boolean;
}) {
  const { owner, repo, number, enabled } = args;
  const trpc = useTRPC();
  const query = useInfiniteQuery(
    trpc.githubPrReview.listFiles.infiniteQueryOptions(
      { owner, repo, number },
      {
        staleTime: 30_000,
        enabled,
        getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
        // Cap at the server's page ceiling so we never request page 61.
        // 60 pages × 100/page = 6,000 files, which is well above the
        // 3,000 truncation banner so fetch-to-completion still has
        // headroom to actually finish.
        maxPages: PR_REVIEW_MAX_PAGES,
      }
    )
  );

  const errorState = query.error ? classifyPrReviewQueryState(query.error) : null;
  // A first-page error is one where NO page has loaded yet. A failure while
  // fetching a LATER page (already-loaded files present) is a later-page error
  // and must not blank the screen — consumers keep the loaded files and offer a
  // resume/retry affordance instead.
  const hasLoadedPages = (query.data?.pages.length ?? 0) > 0;
  const firstPageErrorState = hasLoadedPages ? null : errorState;
  const laterPageError = Boolean(query.error) && hasLoadedPages;

  return {
    query,
    errorState,
    firstPageErrorState,
    laterPageError,
  };
}

export type UsePrReviewFileListQueryResult = ReturnType<typeof usePrReviewFileListQuery>;

/**
 * Subscribes the viewed-files store for a specific PR (keyed by
 * `owner/repo#number` + `headSha`). Returns the current viewed path
 * set plus a `toggle` callback that flips a single path. The
 * underlying store is a single SecureStore key shared across all
 * PRs, so the hook re-reads on toggle rather than maintaining a
 * long-lived in-memory cache.
 */
// Module-level notifier so every mounted viewed-files hook (e.g. the diff list
// AND the file navigator sheet mounted over it) re-reads after any toggle,
// keeping their viewed indicators in sync without prop drilling.
const viewedChangeListeners = new Set<() => void>();

function notifyViewedChange(): void {
  for (const listener of viewedChangeListeners) {
    listener();
  }
}

export function usePrReviewViewedFiles(
  ref: {
    owner: string;
    repo: string;
    number: number;
  },
  headSha: string
) {
  const { owner, repo, number } = ref;
  const [paths, setPaths] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    async function load() {
      try {
        const next = await getViewedFiles({ owner, repo, number }, headSha);
        if (!cancelled) {
          setPaths(next);
          setIsLoading(false);
        }
      } catch {
        if (!cancelled) {
          setPaths([]);
          setIsLoading(false);
        }
      }
    }

    void load();
    // Re-read whenever any instance toggles a file so this instance stays in
    // sync (the navigator sheet and the underlying diff list share the store).
    const onChange = () => {
      void load();
    };
    viewedChangeListeners.add(onChange);
    return () => {
      cancelled = true;
      viewedChangeListeners.delete(onChange);
    };
  }, [owner, repo, number, headSha]);

  const toggle = useCallback(
    async (path: string) => {
      // Optimistic toggle: flip the local set first so the UI updates
      // instantly. The store write is durable (SecureStore).
      setPaths(previous => {
        if (previous.includes(path)) {
          return previous.filter(p => p !== path);
        }
        return [...previous, path];
      });
      await toggleViewedFile({ owner, repo, number, headSha, path });
      // Notify other mounted instances (they re-read the durable store).
      notifyViewedChange();
    },
    [owner, repo, number, headSha]
  );

  const set = new Set(paths);
  return { isViewed: (path: string) => set.has(path), toggle, isLoading };
}

/**
 * Drives an infinite list query to completion. Used by the file
 * navigator (S6c) which needs the full listed set to offer a working
 * search/scrubber. Returns an imperative `run()` so the consumer can
 * start it from a button or an effect and observe progress via
 * `isRunning` / `loadedFiles` / `error`.
 */
export type FetchToCompletionResult = {
  run: () => Promise<void>;
  isRunning: boolean;
  loadedFiles: number;
  totalFiles: number | null;
  error: unknown;
};

export function useFetchToCompletion(
  query: ReturnType<typeof usePrReviewFileListQuery>['query'],
  totalFiles: number | null
): FetchToCompletionResult {
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const loadedFiles = (query.data?.pages ?? []).reduce((sum, page) => sum + page.files.length, 0);

  const run = useCallback(async () => {
    if (query.isFetching || !query.hasNextPage) {
      return;
    }
    setError(null);
    setIsRunning(true);
    try {
      // Loop instead of recursing to keep the call stack flat. Pages must be
      // fetched sequentially because each request needs the previous page's
      // cursor, so `await` inside the loop is intentional here.
      // The `hasNextPage` value is re-checked on each iteration via the
      // result of `fetchNextPage` (not a stale closure), so the loop
      // condition is intentionally the live query flag.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- hasNextPage is re-evaluated after each page
      while (query.hasNextPage) {
        // eslint-disable-next-line no-await-in-loop -- sequential cursor pagination
        const result = await query.fetchNextPage();
        if (!result.data || !result.hasNextPage) {
          break;
        }
      }
    } catch (caughtError) {
      setError(caughtError);
    } finally {
      setIsRunning(false);
    }
  }, [query]);

  return { run, isRunning, loadedFiles, totalFiles, error };
}
