'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type CursorPage<TEntry> = {
  entries: TEntry[];
  cursor: string | null;
  hasMore: boolean;
};

/**
 * Manages cursor-based pagination state on top of an initial react-query page.
 *
 * Handles the reset-on-key-change, initial-data sync, and "load more" append
 * logic that would otherwise be copy-pasted across every detail page.
 */
export function useCursorPagination<TEntry>({
  initialData,
  fetchMore,
  resetKey,
}: {
  /** The first page returned by useQuery (pass `query.data`). */
  initialData: CursorPage<TEntry> | undefined;
  /** Fetch the next page given a cursor string. */
  fetchMore: (cursor: string) => Promise<CursorPage<TEntry>>;
  /** When this value changes, all pagination state resets (e.g. a subscription id). */
  resetKey: unknown;
}) {
  const [entries, setEntries] = useState<TEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const prevResetKey = useRef(resetKey);

  // Reset all pagination state when the key changes (synchronous during render).
  if (prevResetKey.current !== resetKey) {
    prevResetKey.current = resetKey;
    setEntries([]);
    setCursor(null);
    setHasMore(false);
    setIsLoadingMore(false);
  }

  useEffect(() => {
    if (!initialData) return;
    setEntries(initialData.entries);
    setCursor(initialData.cursor);
    setHasMore(initialData.hasMore);
  }, [initialData]);

  const loadMore = useCallback(async () => {
    if (!cursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const result = await fetchMore(cursor);
      setEntries(current => [...current, ...result.entries]);
      setCursor(result.cursor);
      setHasMore(result.hasMore);
    } finally {
      setIsLoadingMore(false);
    }
  }, [cursor, isLoadingMore, fetchMore]);

  return { entries, hasMore, isLoadingMore, loadMore } as const;
}
