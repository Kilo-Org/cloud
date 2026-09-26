import { type QueryClient } from '@tanstack/react-query';

import { reconcileFirstPage } from '@/lib/query/infinite-retention';

type QueryPathFilter = {
  pathFilter: () => Parameters<QueryClient['invalidateQueries']>[0];
};

type ListQueryPathFilter = {
  pathFilter: () => Parameters<QueryClient['invalidateQueries']>[0] & {
    queryKey: readonly unknown[];
  };
};

type AgentSessionTrpcQueries = {
  cliSessionsV2: {
    list: ListQueryPathFilter;
    recentRepositories: QueryPathFilter;
  };
  activeSessions: {
    list: QueryPathFilter;
  };
};

export async function invalidateAgentSessionQueries(
  queryClient: Pick<QueryClient, 'invalidateQueries' | 'setQueriesData'>,
  trpc: AgentSessionTrpcQueries
): Promise<void> {
  // Trim the stored list to page one (dropping later pages) and refetch that
  // page. Runs on rename, delete, and create, where the first page is the one
  // that changed.
  reconcileFirstPage(queryClient as QueryClient, trpc.cliSessionsV2.list.pathFilter().queryKey);
  await Promise.all([
    queryClient.invalidateQueries(trpc.cliSessionsV2.recentRepositories.pathFilter()),
    queryClient.invalidateQueries(trpc.activeSessions.list.pathFilter()),
  ]);
}

/**
 * How long a prefetched transcript stays fresh. The preview query shares this
 * value, so reopening a card paints from the react-query cache instead of
 * refetching.
 */
export const SESSION_TRANSCRIPT_STALE_TIME_MS = 60_000;

/**
 * Warm the transcript cache for a session without rendering it. Used when the
 * long-press gesture starts, so the preview opens from cache rather than
 * fetching on the critical path.
 */
export async function prefetchSessionTranscript(
  queryClient: Pick<QueryClient, 'prefetchQuery'>,
  options: { queryKey: readonly unknown[] }
): Promise<void> {
  await queryClient.prefetchQuery({
    ...options,
    staleTime: SESSION_TRANSCRIPT_STALE_TIME_MS,
  });
}
