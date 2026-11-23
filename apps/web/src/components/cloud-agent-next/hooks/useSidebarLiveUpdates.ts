import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  focusManager,
  onlineManager,
  replaceEqualDeep,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import type { UserWebSessionEventData } from '@kilocode/cloud-agent-sdk';
import { KNOWN_PLATFORMS } from '@kilocode/app-shared/platforms';
import type { RootRouter } from '@/routers/root-router';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { useUserWebConnection } from '../CloudAgentProvider';
import type { sidebarListInput, sidebarWorkspaceListInput } from './sidebar-queries';
import {
  getWorkspaceSummaryRefetchInterval,
  type WorkspaceListData,
  type WorkspaceSummary,
} from './useWorkspaceSummaries';
import {
  createWorkspaceRefreshCoordinator,
  WORKSPACE_REFRESH_TIMEOUT_MS,
} from './workspace-refresh';
import { sidebarQueryInput } from './sidebar-query-scope';
import {
  acceptsSidebarStatusUpdate,
  workspaceRefreshChangesMembership,
} from './workspace-refresh-membership';

type Outputs = inferRouterOutputs<RootRouter>['cliSessionsV2'];
type SessionRow = UserWebSessionEventData<'session.created'>['session'];
type SidebarSession = Outputs['list']['cliSessions'][number];
type WorkspaceChat = Outputs['workspaceChats']['chats'][number];
type Options = {
  organizationId: string | null;
  workspaceListInput: ReturnType<typeof sidebarWorkspaceListInput>;
  listInput: ReturnType<typeof sidebarListInput>;
  searchInput: {
    search_string: string;
    organizationId: string | null;
    createdOnPlatform?: string | string[];
    gitUrl?: string | string[];
  };
  isSearchActive: boolean;
  workspaces: readonly WorkspaceSummary[];
};

function patchCachedQuery<T>(queryClient: QueryClient, queryKey: QueryKey, patch: (data: T) => T) {
  const state = queryClient.getQueryState<T>(queryKey);
  if (state?.data === undefined) return;
  const data = state.data;
  const updated = replaceEqualDeep(data, patch(data));
  if (updated === data) return;

  if (state.fetchStatus !== 'idle') {
    const cache = queryClient.getQueryCache();
    const query = cache.find<T>({ queryKey, exact: true });
    if (query?.state.fetchMeta?.fetchMore) {
      // Pagination appends to the pages it captured before the live patch.
      void query.promise?.then(
        () => {
          if (cache.get(query.queryHash) !== query) return;
          const latest = query.state.data;
          if (latest === undefined) return;
          const reapplied = replaceEqualDeep(latest, patch(latest));
          if (reapplied !== latest) queryClient.setQueryData(queryKey, reapplied);
        },
        () => undefined
      );
    } else {
      // Reverting before the write resets fetchStatus without publishing a cancellation error.
      void query?.cancel({ revert: true });
    }
  }
  queryClient.setQueryData(queryKey, updated);
}

function matchesRow(row: SessionRow, options: Options): boolean {
  if (row.organizationId !== options.organizationId || row.parentSessionId) return false;
  const platforms = options.listInput.createdOnPlatform;
  const choices =
    platforms === undefined ? null : Array.isArray(platforms) ? platforms : [platforms];
  if (
    choices &&
    !choices.some(
      platform =>
        platform === row.createdOnPlatform ||
        (platform === 'other' && !KNOWN_PLATFORMS.some(known => known === row.createdOnPlatform))
    )
  )
    return false;
  const repositories = options.listInput.gitUrl;
  return (
    repositories === undefined ||
    (Array.isArray(repositories) ? repositories : [repositories]).some(url => url === row.gitUrl)
  );
}

export function useSidebarLiveUpdates(options: Options): void {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const connection = useUserWebConnection();
  const focused = useSyncExternalStore(
    focusManager.subscribe,
    () => focusManager.isFocused(),
    () => true
  );
  const online = useSyncExternalStore(
    onlineManager.subscribe,
    () => onlineManager.isOnline(),
    () => true
  );
  const current = useRef(options);
  current.current = options;

  const createRefresh = useMemo(
    () => () =>
      createWorkspaceRefreshCoordinator(
        async ids => {
          const scope = current.current;
          const fetchSummaries = (
            input: inferRouterInputs<RootRouter>['cliSessionsV2']['workspaceSummaries']
          ) =>
            queryClient.fetchQuery({
              ...trpc.cliSessionsV2.workspaceSummaries.queryOptions(input),
              queryFn: async ({ signal }) => {
                const deadline = new AbortController();
                const timer = setTimeout(
                  () => deadline.abort(new Error('Workspace summary refresh timed out')),
                  WORKSPACE_REFRESH_TIMEOUT_MS
                );
                try {
                  return await trpcClient.cliSessionsV2.workspaceSummaries.query(input, {
                    signal: AbortSignal.any([signal, deadline.signal]),
                  });
                } finally {
                  clearTimeout(timer);
                }
              },
              staleTime: 0,
              gcTime: 60_000,
              retry: 1,
            });
          const worktreeIds = ids.flatMap(id => {
            const parsed = cloudAgentWorktreeIdSchema.safeParse(id);
            return parsed.success ? [parsed.data] : [];
          });
          if (worktreeIds.length === 0) return;
          const result = await fetchSummaries({
            organizationId: scope.organizationId,
            worktreeIds,
            createdOnPlatform: scope.workspaceListInput.createdOnPlatform,
            gitUrl: scope.workspaceListInput.gitUrl,
            search: scope.workspaceListInput.search,
          });
          const replacements = new Map(result.workspaces.map(row => [row.worktreeId, row]));
          const lookupIds = new Set(
            queryClient
              .getQueriesData<Outputs['workspaceSummaries']>(
                trpc.cliSessionsV2.workspaceSummaries.pathFilter()
              )
              .flatMap(([key, data]) =>
                sidebarQueryInput(key)?.organizationId === scope.organizationId
                  ? (data?.workspaces.map(row => row.worktreeId) ?? [])
                  : []
              )
          );
          const missingLookupIds = worktreeIds.filter(
            id => !replacements.has(id) && lookupIds.has(id)
          );
          const lookupReplacements = new Map(replacements);
          if (missingLookupIds.length > 0) {
            const lookups = await fetchSummaries({
              organizationId: scope.organizationId,
              worktreeIds: missingLookupIds,
            });
            for (const row of lookups.workspaces) lookupReplacements.set(row.worktreeId, row);
          }
          if (current.current !== scope) {
            if (
              current.current.organizationId !== scope.organizationId ||
              current.current.workspaceListInput !== scope.workspaceListInput
            )
              return;
          }
          const requested = new Set<string>(worktreeIds);
          const listKey = trpc.cliSessionsV2.listWorkspaces.infiniteQueryKey(
            scope.workspaceListInput
          );
          const cachedRows = queryClient
            .getQueryData<InfiniteData<WorkspaceListData>>(listKey)
            ?.pages.flatMap(page => page.workspaces);
          const membershipChanged =
            cachedRows &&
            workspaceRefreshChangesMembership(cachedRows, result.workspaces, worktreeIds);
          const foldersChanged = cachedRows?.some(
            row =>
              replacements.has(row.worktreeId) &&
              replacements.get(row.worktreeId)?.folderId !== row.folderId
          );
          const replaceRows = (
            rows: WorkspaceSummary[],
            byId: ReadonlyMap<string, WorkspaceSummary>
          ) =>
            rows.flatMap(row => {
              const replacement = byId.get(row.worktreeId);
              return replacement ? [replacement] : requested.has(row.worktreeId) ? [] : [row];
            });
          patchCachedQuery<InfiniteData<WorkspaceListData>>(queryClient, listKey, data => ({
            ...data,
            pages: data.pages.map(page => ({
              ...page,
              workspaces: replaceRows(page.workspaces, replacements),
            })),
          }));
          for (const [key] of queryClient.getQueriesData<Outputs['workspaceSummaries']>({
            ...trpc.cliSessionsV2.workspaceSummaries.pathFilter(),
            predicate: query =>
              sidebarQueryInput(query.queryKey)?.organizationId === scope.organizationId,
          })) {
            patchCachedQuery<Outputs['workspaceSummaries']>(queryClient, key, data => ({
              ...data,
              workspaces: replaceRows(data.workspaces, lookupReplacements),
            }));
          }
          if (membershipChanged)
            void queryClient.invalidateQueries(
              trpc.cliSessionsV2.listWorkspaces.infiniteQueryFilter(scope.workspaceListInput),
              { cancelRefetch: false }
            );
          if (foldersChanged)
            void queryClient.invalidateQueries(
              {
                ...trpc.workspaceFolders.list.pathFilter(),
                predicate: query =>
                  sidebarQueryInput(query.queryKey)?.organizationId === scope.organizationId,
              },
              { cancelRefetch: false }
            );
        },
        (_error, failedIds) => {
          void queryClient.invalidateQueries({
            ...trpc.cliSessionsV2.workspaceSummaries.pathFilter(),
            refetchType: 'none',
            predicate: query => {
              const input = sidebarQueryInput(query.queryKey);
              return (
                input?.organizationId === current.current.organizationId &&
                'worktreeIds' in input &&
                Array.isArray(input.worktreeIds) &&
                input.worktreeIds.some(id => failedIds.includes(id))
              );
            },
          });
        }
      ),
    [queryClient, trpc, trpcClient]
  );

  const refresh = useRef<ReturnType<typeof createWorkspaceRefreshCoordinator> | null>(null);
  useEffect(() => {
    const coordinator = createRefresh();
    refresh.current = coordinator;
    return () => {
      coordinator.dispose();
      if (refresh.current === coordinator) refresh.current = null;
    };
  }, [createRefresh]);

  useEffect(() => {
    if (!connection) return;
    const patchSessionCaches = (
      scope: Options,
      patchSession: (session: SidebarSession) => SidebarSession | null,
      patchChat: (chat: WorkspaceChat) => WorkspaceChat | null
    ) => {
      const patchRows = <T>(rows: T[], patch: (row: T) => T | null) =>
        rows.flatMap(row => patch(row) ?? []);
      patchCachedQuery<Outputs['list']>(
        queryClient,
        trpc.cliSessionsV2.list.queryKey(scope.listInput),
        data => ({
          ...data,
          cliSessions: patchRows(data.cliSessions, session => {
            const updated = patchSession(session);
            return scope.listInput.standaloneOnly &&
              !session.cloud_agent_worktree_id &&
              updated?.cloud_agent_worktree_id
              ? null
              : updated;
          }),
        })
      );
      patchCachedQuery<Outputs['search']>(
        queryClient,
        trpc.cliSessionsV2.search.queryKey(scope.searchInput),
        data => ({ ...data, results: patchRows(data.results, patchSession) })
      );
      const chatsQueries = queryClient.getQueryCache().findAll({
        ...trpc.cliSessionsV2.workspaceChats.pathFilter(),
        predicate: query =>
          sidebarQueryInput(query.queryKey)?.organizationId === scope.organizationId,
      });
      for (const { queryKey } of chatsQueries)
        patchCachedQuery<InfiniteData<Outputs['workspaceChats']>>(queryClient, queryKey, data => ({
          ...data,
          pages: data.pages.map(page => ({ ...page, chats: patchRows(page.chats, patchChat) })),
        }));
    };
    const refreshSessionWorkspace = (sessionId: string, worktreeId?: string | null) => {
      const scope = current.current;
      const hasSession = (workspace: WorkspaceSummary) =>
        [...workspace.openChats, ...workspace.closedChats].some(
          chat => chat.sessionId === sessionId
        );
      const workspaceId =
        worktreeId ??
        scope.workspaces.find(hasSession)?.worktreeId ??
        queryClient
          .getQueriesData<Outputs['workspaceSummaries']>(
            trpc.cliSessionsV2.workspaceSummaries.pathFilter()
          )
          .flatMap(([key, data]) =>
            sidebarQueryInput(key)?.organizationId === scope.organizationId
              ? (data?.workspaces ?? [])
              : []
          )
          .find(hasSession)?.worktreeId;
      if (workspaceId) refresh.current?.schedule(workspaceId);
    };
    const patchRow = (row: SessionRow, metadataChanged: boolean) => {
      const scope = current.current;
      if (row.organizationId !== scope.organizationId) return;
      if (!row.parentSessionId) refreshSessionWorkspace(row.sessionId, row.worktreeId);
      patchSessionCaches(
        scope,
        session => {
          if (
            session.session_id !== row.sessionId ||
            !acceptsSidebarStatusUpdate(
              { statusUpdatedAt: session.status_updated_at, updatedAt: session.updated_at },
              row
            )
          )
            return session;
          return {
            ...session,
            title: row.title,
            git_url: row.gitUrl,
            git_branch: row.gitBranch,
            cloud_agent_worktree_id: row.worktreeId ?? session.cloud_agent_worktree_id,
            status: row.status,
            status_updated_at: row.statusUpdatedAt,
            updated_at: row.updatedAt,
          };
        },
        chat =>
          chat.sessionId === row.sessionId &&
          acceptsSidebarStatusUpdate(
            { statusUpdatedAt: chat.sessionStatusUpdatedAt, updatedAt: chat.updatedAt },
            row
          )
            ? {
                ...chat,
                title: row.title,
                updatedAt: row.updatedAt,
                sessionStatus: row.status,
                sessionStatusUpdatedAt: row.statusUpdatedAt,
              }
            : chat
      );
      if (!metadataChanged || !matchesRow(row, scope)) return;
      if (!row.worktreeId)
        void queryClient.invalidateQueries(trpc.cliSessionsV2.list.queryFilter(scope.listInput), {
          cancelRefetch: false,
        });
      if (scope.isSearchActive)
        void queryClient.invalidateQueries(
          trpc.cliSessionsV2.search.queryFilter(scope.searchInput),
          { cancelRefetch: false }
        );
    };
    const refreshRepositories = () => {
      const scope = current.current;
      void queryClient.invalidateQueries(
        {
          ...trpc.cliSessionsV2.recentRepositories.pathFilter(),
          predicate: query =>
            sidebarQueryInput(query.queryKey)?.organizationId === scope.organizationId,
        },
        { cancelRefetch: false }
      );
    };
    const unsubscribe = [
      connection.onSessionEvent('workspace.updated', event =>
        refresh.current?.schedule(event.worktreeId)
      ),
      connection.onSessionEvent('session.created', event => {
        patchRow(event.session, true);
        if (matchesRow(event.session, current.current)) refreshRepositories();
      }),
      connection.onSessionEvent('session.updated', event => {
        const scope = current.current;
        const previous = queryClient
          .getQueryData<Outputs['list']>(trpc.cliSessionsV2.list.queryKey(scope.listInput))
          ?.cliSessions.find(row => row.session_id === event.session.sessionId);
        patchRow(event.session, true);
        const previousWorkspace = scope.workspaces.find(workspace =>
          [...workspace.openChats, ...workspace.closedChats].some(
            chat => chat.sessionId === event.session.sessionId
          )
        );
        if (
          matchesRow(event.session, scope) &&
          (previous?.git_url ?? previousWorkspace?.gitUrl) !== event.session.gitUrl
        )
          refreshRepositories();
      }),
      connection.onSessionEvent('session.status.updated', event => {
        if ('session' in event) {
          patchRow(event.session, false);
          return;
        }
        const scope = current.current;
        refreshSessionWorkspace(event.sessionId);
        const incoming = {
          statusUpdatedAt: event.statusUpdatedAt,
          updatedAt: event.updatedAt ?? event.changedAt,
        };
        patchSessionCaches(
          scope,
          row =>
            row.session_id === event.sessionId &&
            acceptsSidebarStatusUpdate(
              { statusUpdatedAt: row.status_updated_at, updatedAt: row.updated_at },
              incoming
            )
              ? {
                  ...row,
                  status: event.status,
                  status_updated_at: event.statusUpdatedAt,
                  updated_at: incoming.updatedAt,
                }
              : row,
          chat =>
            chat.sessionId === event.sessionId &&
            acceptsSidebarStatusUpdate(
              { statusUpdatedAt: chat.sessionStatusUpdatedAt, updatedAt: chat.updatedAt },
              incoming
            )
              ? {
                  ...chat,
                  sessionStatus: event.status,
                  sessionStatusUpdatedAt: event.statusUpdatedAt,
                  updatedAt: incoming.updatedAt,
                }
              : chat
        );
      }),
      connection.onSessionEvent('session.deleted', event => {
        const scope = current.current;
        if (event.organizationId !== scope.organizationId) return;
        if (!event.parentSessionId) refreshSessionWorkspace(event.sessionId, event.worktreeId);
        patchSessionCaches(
          scope,
          row => (row.session_id === event.sessionId ? null : row),
          chat => (chat.sessionId === event.sessionId ? null : chat)
        );
      }),
      connection.onReconnect(() => {
        const scope = current.current;
        void queryClient.invalidateQueries(
          trpc.cliSessionsV2.listWorkspaces.infiniteQueryFilter(scope.workspaceListInput),
          { cancelRefetch: false }
        );
        void queryClient.invalidateQueries(trpc.cliSessionsV2.list.queryFilter(scope.listInput), {
          cancelRefetch: false,
        });
        for (const filter of [
          trpc.cliSessionsV2.workspaceSummaries.pathFilter(),
          trpc.cliSessionsV2.workspaceChats.pathFilter(),
        ])
          void queryClient.invalidateQueries(
            {
              ...filter,
              predicate: query =>
                sidebarQueryInput(query.queryKey)?.organizationId === scope.organizationId,
            },
            { cancelRefetch: false }
          );
        if (scope.isSearchActive)
          void queryClient.invalidateQueries(
            trpc.cliSessionsV2.search.queryFilter(scope.searchInput),
            { cancelRefetch: false }
          );
      }),
    ];
    return () => unsubscribe.forEach(dispose => dispose());
  }, [connection, queryClient, refresh, trpc]);

  const pollAt = useRef(new Map<string, number>());
  useEffect(() => {
    if (!focused || !online) return;
    const now = Date.now();
    const polling = options.workspaces.flatMap(workspace => {
      const interval = getWorkspaceSummaryRefetchInterval(workspace, now);
      return interval ? [{ id: workspace.worktreeId, interval }] : [];
    });
    const ids = new Set(polling.map(row => row.id));
    for (const id of pollAt.current.keys()) if (!ids.has(id)) pollAt.current.delete(id);
    if (polling.length === 0) return;
    for (const row of polling)
      if (!pollAt.current.has(row.id)) pollAt.current.set(row.id, now + row.interval);
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const dueAt = Math.min(
        ...polling.map(row => pollAt.current.get(row.id) ?? Date.now() + row.interval)
      );
      timer = setTimeout(
        () => {
          const at = Date.now();
          for (const row of polling) {
            const workspace = current.current.workspaces.find(
              workspace => workspace.worktreeId === row.id
            );
            const interval = workspace && getWorkspaceSummaryRefetchInterval(workspace, at);
            if (!interval) {
              pollAt.current.delete(row.id);
              continue;
            }
            if ((pollAt.current.get(row.id) ?? Infinity) <= at) {
              refresh.current?.schedule(row.id);
              pollAt.current.set(row.id, at + interval);
            }
          }
          if (pollAt.current.size > 0) schedule();
        },
        Math.max(0, dueAt - Date.now())
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [focused, online, options.workspaces, refresh]);
}
