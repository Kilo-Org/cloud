import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  sidebarListInput,
  sidebarUpdatedSince,
  sidebarWorkspaceListInput,
} from './sidebar-queries';
import { useWorkspaceSummaries } from './useWorkspaceSummaries';
import { useStandaloneSessions, type SidebarSearchInput } from './useStandaloneSessions';
import { useSidebarLiveUpdates } from './useSidebarLiveUpdates';
import { workspaceSummaryChats, workspaceRowToSidebarDetails } from './sidebar-workspace-model';

export * from './sidebar-session-model';
export { groupSidebarWorkspaces, workspaceRowToSidebarDetails } from './sidebar-workspace-model';
export {
  nextPrLinkVerification,
  PR_LINK_ATTEMPT_HISTORY_LIMIT,
  recordPrLinkVerificationAttempt,
  shouldRetryPrLinkVerification,
} from './useStandaloneSessions';

type UseSidebarSessionsOptions = {
  organizationId?: string | null;
  updatedSince?: string;
  searchQuery?: string;
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
};

export function useSidebarSessions(options: UseSidebarSessionsOptions = {}) {
  const { organizationId = null, searchQuery = '', createdOnPlatform, gitUrl } = options;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [updatedSince] = useState(() => options.updatedSince ?? sidebarUpdatedSince(new Date()));
  const workspaceListInput = useMemo(
    () =>
      sidebarWorkspaceListInput({ organizationId, createdOnPlatform, gitUrl, search: searchQuery }),
    [organizationId, createdOnPlatform, gitUrl, searchQuery]
  );
  const listInput = useMemo(
    () => sidebarListInput({ updatedSince, organizationId, createdOnPlatform, gitUrl }),
    [updatedSince, organizationId, createdOnPlatform, gitUrl]
  );
  const searchInput = useMemo<SidebarSearchInput>(
    () => ({ search_string: searchQuery, organizationId, createdOnPlatform, gitUrl }),
    [searchQuery, organizationId, createdOnPlatform, gitUrl]
  );
  const isSearchActive = Boolean(searchQuery.trim());
  const refetchSessions = useCallback(() => {
    void queryClient.invalidateQueries(trpc.cliSessionsV2.list.queryFilter(listInput));
    void queryClient.invalidateQueries(trpc.cliSessionsV2.search.queryFilter(searchInput));
    void queryClient.invalidateQueries(
      trpc.cliSessionsV2.listWorkspaces.infiniteQueryFilter(workspaceListInput)
    );
    void queryClient.invalidateQueries(trpc.cliSessionsV2.workspaceSummaries.pathFilter());
  }, [listInput, queryClient, searchInput, trpc, workspaceListInput]);
  const workspaces = useWorkspaceSummaries(workspaceListInput);
  const standalone = useStandaloneSessions({
    listInput,
    searchInput,
    isSearchActive,
    onPrChanged: refetchSessions,
  });
  useSidebarLiveUpdates({
    organizationId,
    workspaceListInput,
    listInput,
    searchInput,
    isSearchActive,
    workspaces: workspaces.workspaces,
  });
  const worktreeDetails = useMemo(
    () =>
      Object.fromEntries(
        workspaces.workspaces.map(row => [row.worktreeId, workspaceRowToSidebarDetails(row)])
      ),
    [workspaces.workspaces]
  );
  const cachedSessions = useMemo(
    () => [
      ...standalone.standaloneSessions,
      ...workspaces.workspaces.flatMap(workspaceSummaryChats),
    ],
    [standalone.standaloneSessions, workspaces.workspaces]
  );
  return {
    sessions: standalone.sessions,
    cachedSessions,
    worktreeDetails,
    workspaceRows: workspaces.workspaces,
    workspaceOrder: workspaces.workspaceOrder,
    destinationTotals: workspaces.destinationTotals,
    isLoading: standalone.isLoading || (!isSearchActive && workspaces.isLoading),
    isSearching: isSearchActive && (standalone.isFetching || workspaces.isFetching),
    workspaceError: workspaces.isError,
    retryWorkspaces: () => {
      void workspaces.refetch();
    },
    hasMoreWorkspaces: workspaces.hasNextPage,
    isLoadingMoreWorkspaces: workspaces.isFetchingNextPage,
    loadMoreWorkspaces: () => {
      void workspaces.fetchNextPage();
    },
    refetchSessions,
  };
}
