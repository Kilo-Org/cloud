import { useCallback, useState } from 'react';

import { announcingToast } from '@/lib/a11y/announcing-toast';

// Wraps a pull-to-refresh refetch with a "refreshing" flag and a toast on
// failure. Callers with multiple queries to refetch should reduce their
// results into a single `{ isError }` before passing `refetch` in.
export function useManualRefresh(
  refetch: () => Promise<{ isError: boolean }>,
  errorMessage: string
): [boolean, () => void] {
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(() => {
    void (async () => {
      setRefreshing(true);
      try {
        const result = await refetch();
        if (result.isError) {
          announcingToast.error(errorMessage);
        }
      } finally {
        setRefreshing(false);
      }
    })();
  }, [refetch, errorMessage]);

  return [refreshing, onRefresh];
}
