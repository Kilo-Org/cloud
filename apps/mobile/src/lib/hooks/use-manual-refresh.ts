import { useCallback, useEffect, useRef, useState } from 'react';

import { announcingToast } from '@/lib/a11y/announcing-toast';

// Wraps a pull-to-refresh refetch with a "refreshing" flag and a toast on
// failure. Callers with multiple queries to refetch should reduce their
// results into a single `{ isError }` before passing `refetch` in. A read that
// settles after the calling screen unmounted announces nothing and writes no
// state.
export function useManualRefresh(
  refetch: () => Promise<{ isError: boolean }>,
  errorMessage: string
): [boolean, () => void] {
  const [refreshing, setRefreshing] = useState(false);
  // False until the mount commits, so a caller that leaves inside its own mount
  // window still reads as unmounted.
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const onRefresh = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }
    void (async () => {
      setRefreshing(true);
      try {
        const result = await refetch();
        if (mountedRef.current && result.isError) {
          announcingToast.error(errorMessage);
        }
      } finally {
        if (mountedRef.current) {
          setRefreshing(false);
        }
      }
    })();
  }, [refetch, errorMessage]);

  return [refreshing, onRefresh];
}
