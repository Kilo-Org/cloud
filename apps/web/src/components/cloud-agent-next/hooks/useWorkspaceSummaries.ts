import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  notifyManager,
  skipToken,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import type { RootRouter } from '@/routers/root-router';
import { useTRPC } from '@/lib/trpc/utils';
import { WORKSPACE_STALE_STATUS_MS } from '@/lib/cloud-agent/workspace-activity';
import {
  sidebarQueryScopeKey,
  sidebarScopeKey,
  type sidebarWorkspaceListInput,
} from './sidebar-queries';
import { MAX_STACK_ANCESTRY } from '../workspace-stacks';

export type WorkspaceListData = inferRouterOutputs<RootRouter>['cliSessionsV2']['listWorkspaces'];
export type WorkspaceSummary = WorkspaceListData['workspaces'][number];
type WorkspaceSummariesData = inferRouterOutputs<RootRouter>['cliSessionsV2']['workspaceSummaries'];

export function getWorkspaceSummaryRefetchInterval(
  workspace: WorkspaceSummary,
  now = Date.now()
): number | false {
  if (workspace.pr?.reviewDecisionPending) return 5_000;
  const status = workspace.sessionStatus;
  const statusAt = new Date(workspace.status.statusUpdatedAt ?? workspace.lastActivityAt).getTime();
  if ((status === 'busy' || status === 'retry') && now - statusAt >= WORKSPACE_STALE_STATUS_MS)
    return false;
  return status === 'busy' || status === 'retry' || workspace.hasOpenRun ? 30_000 : false;
}

export function useWorkspaceSummaries(input: ReturnType<typeof sidebarWorkspaceListInput>) {
  const trpc = useTRPC();
  const query = useInfiniteQuery({
    ...trpc.cliSessionsV2.listWorkspaces.infiniteQueryOptions(input, {
      getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    }),
    staleTime: 5_000,
    placeholderData: (previous, query) =>
      query && sidebarQueryScopeKey(query.queryKey) === sidebarScopeKey(input)
        ? previous
        : undefined,
  });
  const workspaces = useMemo(
    () => query.data?.pages.flatMap(page => page.workspaces) ?? [],
    [query.data?.pages]
  );
  return {
    ...query,
    workspaces,
    workspaceOrder: query.data?.pages[0]?.workspaceOrder ?? 'manual',
    destinationTotals: query.data?.pages[0]?.destinationTotals ?? {},
    truncated: query.data?.pages.some(page => page.truncated) ?? false,
  };
}

function queryOrganizationId(queryKey: readonly unknown[]): unknown {
  const options = queryKey[1];
  if (!options || typeof options !== 'object' || !('input' in options)) return undefined;
  const input = options.input;
  return input && typeof input === 'object' && 'organizationId' in input
    ? input.organizationId
    : undefined;
}

export function useCachedWorkspaceSummaries(organizationId: string | null): WorkspaceSummary[] {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const cache = queryClient.getQueryCache();
  const listFilter = trpc.cliSessionsV2.listWorkspaces.pathFilter();
  const summaryFilter = trpc.cliSessionsV2.workspaceSummaries.pathFilter();
  const subscribe = useCallback(
    (notify: () => void) => cache.subscribe(notifyManager.batchCalls(notify)),
    [cache]
  );
  const snapshot = () =>
    [...cache.findAll(listFilter), ...cache.findAll(summaryFilter)]
      .filter(
        query =>
          query.state.data !== undefined && queryOrganizationId(query.queryKey) === organizationId
      )
      .map(query => `${query.queryHash}:${query.state.dataUpdateCount}`)
      .join('|');
  const version = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => {
    const lists = queryClient
      .getQueriesData<InfiniteData<WorkspaceListData>>(listFilter)
      .flatMap(([key, data]) =>
        data && queryOrganizationId(key) === organizationId
          ? [{ key, workspaces: data.pages.flatMap(page => page.workspaces) }]
          : []
      );
    const summaries = queryClient
      .getQueriesData<WorkspaceSummariesData>(summaryFilter)
      .flatMap(([key, data]) =>
        data && queryOrganizationId(key) === organizationId
          ? [{ key, workspaces: data.workspaces }]
          : []
      );
    const sources = [...lists, ...summaries].sort(
      (a, b) =>
        (queryClient.getQueryState(a.key)?.dataUpdatedAt ?? 0) -
        (queryClient.getQueryState(b.key)?.dataUpdatedAt ?? 0)
    );
    const byId = new Map<string, WorkspaceSummary>();
    for (const source of sources)
      for (const workspace of source.workspaces) byId.set(workspace.worktreeId, workspace);
    return [...byId.values()];
  }, [organizationId, queryClient, trpc, version]);
}

export function getMissingWorkspaceAncestorIds(
  worktreeIds: readonly string[],
  workspaces: readonly WorkspaceSummary[]
): string[] {
  const byId = new Map(workspaces.map(workspace => [workspace.worktreeId, workspace]));
  const missing = new Set<string>();
  for (const worktreeId of worktreeIds) {
    const seen = new Set<string>();
    let current: string | null = worktreeId;
    while (current && !seen.has(current) && seen.size < MAX_STACK_ANCESTRY) {
      seen.add(current);
      const workspace = byId.get(current);
      if (!workspace) {
        missing.add(current);
        break;
      }
      current = workspace.parentWorktreeId;
      if (
        !current &&
        workspace.stackRootId !== workspace.worktreeId &&
        !byId.has(workspace.stackRootId)
      )
        missing.add(workspace.stackRootId);
    }
  }
  return [...missing].sort();
}

export function useWorkspaceSummaryLookup({
  organizationId,
  worktreeIds,
  enabled = true,
}: {
  organizationId: string | null;
  worktreeIds: readonly string[];
  enabled?: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const cached = useCachedWorkspaceSummaries(organizationId);
  const missing = useMemo(
    () =>
      getMissingWorkspaceAncestorIds(worktreeIds, cached).flatMap(id => {
        const parsed = cloudAgentWorktreeIdSchema.safeParse(id);
        return parsed.success ? [parsed.data] : [];
      }),
    [cached, worktreeIds]
  );
  const requestedIds = useMemo(
    () =>
      [...new Set(worktreeIds)]
        .sort()
        .flatMap(id => {
          const parsed = cloudAgentWorktreeIdSchema.safeParse(id);
          return parsed.success ? [parsed.data] : [];
        })
        .slice(0, 200),
    [worktreeIds]
  );
  const initialData = useMemo(() => {
    if (missing.length > 0 || requestedIds.length === 0) return undefined;
    const requested = new Set<string>(requestedIds);
    const roots = new Set(
      cached.filter(row => requested.has(row.worktreeId)).map(row => row.stackRootId)
    );
    return {
      workspaces: cached.filter(row => requested.has(row.worktreeId) || roots.has(row.stackRootId)),
    };
  }, [cached, missing.length, requestedIds]);
  const initialDataUpdatedAt = () => {
    const times = new Map<string, number>();
    const retainTime = (key: readonly unknown[], rows: readonly WorkspaceSummary[]) => {
      if (queryOrganizationId(key) !== organizationId) return;
      const updatedAt = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
      for (const row of rows)
        times.set(row.worktreeId, Math.max(times.get(row.worktreeId) ?? 0, updatedAt));
    };
    for (const [key, data] of queryClient.getQueriesData<InfiniteData<WorkspaceListData>>(
      trpc.cliSessionsV2.listWorkspaces.pathFilter()
    )) {
      if (data)
        retainTime(
          key,
          data.pages.flatMap(page => page.workspaces)
        );
    }
    for (const [key, data] of queryClient.getQueriesData<WorkspaceSummariesData>(
      trpc.cliSessionsV2.workspaceSummaries.pathFilter()
    )) {
      if (data) retainTime(key, data.workspaces);
    }
    return Math.min(...(initialData?.workspaces ?? []).map(row => times.get(row.worktreeId) ?? 0));
  };
  const lookupIds = missing.length > 0 ? missing.slice(0, 200) : requestedIds;
  const query = useQuery({
    ...trpc.cliSessionsV2.workspaceSummaries.queryOptions(
      lookupIds.length > 0 && enabled
        ? { organizationId, worktreeIds: lookupIds, includeAncestors: true }
        : skipToken
    ),
    initialData,
    initialDataUpdatedAt,
    staleTime: 30_000,
  });
  const workspaces = useMemo(() => {
    const byId = new Map(cached.map(workspace => [workspace.worktreeId, workspace]));
    for (const workspace of query.data?.workspaces ?? []) byId.set(workspace.worktreeId, workspace);
    return [...byId.values()];
  }, [cached, query.data?.workspaces]);
  return { ...query, workspaces };
}
