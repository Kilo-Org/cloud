'use client';

import { useState, useCallback } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';

type UseRefreshRepositoriesOptions = {
  /**
   * Returns query options for fetching fresh data (forceRefresh: true)
   * Compatible with TRPC's queryOptions()
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRefreshQueryOptions: () => any;
  /**
   * Returns the cache key for the non-refresh query (forceRefresh: false)
   * This is used to update the cache after refresh
   */
  getCacheQueryKey: () => QueryKey;
  /** Suppress toasts — useful when combining multiple refreshes into one. */
  silent?: boolean;
};

/**
 * Hook for refreshing repository lists across different features
 * Handles the common pattern of:
 * 1. Fetching fresh data with forceRefresh: true
 * 2. Updating the cache for forceRefresh: false queries
 * 3. Showing success/error toasts
 * 4. Managing loading state
 */
export function useRefreshRepositories({
  getRefreshQueryOptions,
  getCacheQueryKey,
  silent = false,
}: UseRefreshRepositoriesOptions) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const freshData = await queryClient.fetchQuery(getRefreshQueryOptions());
      queryClient.setQueryData(getCacheQueryKey(), freshData);
      if (!silent) toast.success('Repositories refreshed');
    } catch (error) {
      if (!silent) {
        toast.error('Failed to refresh repositories', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      if (silent) throw error;
    } finally {
      setIsRefreshing(false);
    }
  }, [queryClient, getRefreshQueryOptions, getCacheQueryKey, silent]);

  return { refresh, isRefreshing };
}
