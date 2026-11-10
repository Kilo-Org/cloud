'use client';

import { useMemo } from 'react';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { useSetAtom } from 'jotai';
import { usePathname, useRouter } from 'next/navigation';
import type { RootRouter } from '@/routers/root-router';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import type { ChatStackInfo } from './ChatHeader';
import { stackedWorkspaceTargetAtom } from './store/stacked-workspace-atoms';
import { sidebarWorkspaceListInput, worktreeDetailsBatches } from './hooks/sidebar-queries';
import { repositoryKey, shortBranchRef } from './worktree-meta';
import { stackedWorkspacePushReason } from './stacked-workspace-preparation';
import type { WorktreeBranchOperationTarget } from './useWorktreeBranchOperations';
import {
  MAX_STACK_ANCESTRY,
  selectWorkspaceStack,
  type WorkspaceStackNode,
  type WorkspaceStackPr,
} from './workspace-stacks';

type WorkspaceListRow =
  inferRouterOutputs<RootRouter>['cliSessionsV2']['listWorkspaces']['workspaces'][number];
type WorktreeDetails = inferRouterOutputs<RootRouter>['cliSessionsV2']['worktreeDetails'];
type WorktreeDetail = WorktreeDetails['worktrees'][string];
type SessionLookup = inferRouterOutputs<RootRouter>['cliSessionsV2']['get'];

function withRefresh<T extends { queryKey: readonly unknown[] }>(
  options: T,
  refreshToken: number
): T {
  return { ...options, queryKey: [...options.queryKey, refreshToken] };
}

type WorkspaceInfo = {
  worktreeId: string;
  name: string | null;
  defaultTitle: string | null;
  branch: string | null;
  parentWorktreeId: string | null;
  baseBranch: string | null;
  gitUrl: string | null;
  repositoryKey: string | null;
  pr: WorkspaceStackPr | null;
  latestSessionId: string | null;
  rootSessionId: string | null;
  prSessionId: string | null;
  prSessionCloudAgentSessionId: string | null;
  folderId: string | null;
};

function rowWorkspace(row: WorkspaceListRow): WorkspaceInfo {
  return {
    worktreeId: row.worktreeId ?? '',
    name: row.name,
    defaultTitle: row.defaultTitle,
    branch: row.branch,
    parentWorktreeId: row.parentWorktreeId,
    baseBranch: row.baseBranch,
    gitUrl: row.gitUrl,
    repositoryKey: repositoryKey({ gitUrl: row.gitUrl, platform: row.pr?.platform }),
    pr: row.pr
      ? {
          number: row.pr.number,
          url: row.pr.url,
          state: row.pr.state,
          baseRef: row.pr.baseRef ?? null,
          stackNumber: row.pr.stackNumber ?? null,
          stackPosition: row.pr.stackPosition ?? null,
          stackSize: row.pr.stackSize ?? null,
          headSha: row.pr.headSha,
        }
      : null,
    latestSessionId: row.latestSessionId ?? null,
    rootSessionId: row.rootSessionId ?? null,
    prSessionId: null,
    prSessionCloudAgentSessionId: null,
    folderId: row.folderId,
  };
}

function detailWorkspace(worktreeId: string, detail: WorktreeDetail): WorkspaceInfo {
  const prSession = detail.prSession;
  const associatedPr = prSession?.associatedPr;
  return {
    worktreeId,
    name: detail.name,
    defaultTitle: detail.defaultTitle,
    branch: detail.branch,
    parentWorktreeId: detail.parentWorktreeId,
    baseBranch: detail.baseBranch,
    gitUrl: prSession?.git_url ?? null,
    repositoryKey: repositoryKey({
      gitUrl: prSession?.git_url,
      platform: associatedPr?.platform,
    }),
    pr: associatedPr
      ? {
          number: associatedPr.number,
          url: associatedPr.url,
          state: associatedPr.state,
          baseRef: associatedPr.baseRef ?? null,
          stackNumber: associatedPr.stackNumber ?? null,
          stackPosition: associatedPr.stackPosition ?? null,
          stackSize: associatedPr.stackSize ?? null,
          headSha: associatedPr.headSha,
        }
      : null,
    latestSessionId: null,
    rootSessionId: null,
    prSessionId: prSession?.session_id ?? null,
    prSessionCloudAgentSessionId: prSession?.cloud_agent_session_id ?? null,
    folderId: detail.folderId,
  };
}

function mergeWorkspace(
  row: WorkspaceInfo | undefined,
  detail: WorkspaceInfo | undefined
): WorkspaceInfo | null {
  if (!row && !detail) return null;
  return {
    worktreeId: row?.worktreeId ?? detail?.worktreeId ?? '',
    name: row?.name ?? detail?.name ?? null,
    defaultTitle: row?.defaultTitle ?? detail?.defaultTitle ?? null,
    branch: row?.branch ?? detail?.branch ?? null,
    parentWorktreeId: row?.parentWorktreeId ?? detail?.parentWorktreeId ?? null,
    baseBranch: row?.baseBranch ?? detail?.baseBranch ?? null,
    gitUrl: row?.gitUrl ?? detail?.gitUrl ?? null,
    repositoryKey: row?.repositoryKey ?? detail?.repositoryKey ?? null,
    pr: row?.pr ?? detail?.pr ?? null,
    latestSessionId: row?.latestSessionId ?? detail?.latestSessionId ?? null,
    rootSessionId: row?.rootSessionId ?? detail?.rootSessionId ?? null,
    prSessionId: row?.prSessionId ?? detail?.prSessionId ?? null,
    prSessionCloudAgentSessionId:
      row?.prSessionCloudAgentSessionId ?? detail?.prSessionCloudAgentSessionId ?? null,
    folderId: row?.folderId ?? detail?.folderId ?? null,
  };
}

function stackNode(workspace: WorkspaceInfo): WorkspaceStackNode {
  return {
    worktreeId: workspace.worktreeId,
    parentWorktreeId: workspace.parentWorktreeId,
    branch: workspace.branch,
    baseBranch: workspace.baseBranch,
    repositoryKey: workspace.repositoryKey,
    pr: workspace.pr,
  };
}

function workspaceLabel(workspace: WorkspaceInfo): string {
  return (
    workspace.name ||
    workspace.defaultTitle ||
    workspace.branch ||
    workspace.gitUrl?.replace(/^.*\//, '').replace(/\.git$/, '') ||
    'Workspace'
  );
}

function workspaceSessionId(workspace: WorkspaceInfo): string | null {
  return workspace.latestSessionId ?? workspace.rootSessionId ?? workspace.prSessionId ?? null;
}

export function useChatStackInfo({
  enabled,
  userId,
  currentWorktreeId,
  cloudAgentSessionId,
  organizationId,
  repository,
  branch,
  gitUrl,
  refreshToken = 0,
  openSession,
}: {
  enabled: boolean;
  userId: string;
  currentWorktreeId: string | null;
  cloudAgentSessionId: string;
  organizationId?: string;
  repository: string;
  branch?: string;
  gitUrl?: string | null;
  refreshToken?: number;
  openSession: (sessionId: string) => void;
}): ChatStackInfo | null {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const router = useRouter();
  const pathname = usePathname();
  const setStackedWorkspaceTarget = useSetAtom(stackedWorkspaceTargetAtom);
  const workspaceListOptions = trpc.cliSessionsV2.listWorkspaces.infiniteQueryOptions(
    sidebarWorkspaceListInput({
      organizationId: organizationId ?? null,
      createdOnPlatform: undefined,
      gitUrl: undefined,
    }),
    { getNextPageParam: lastPage => lastPage.nextCursor ?? undefined }
  );
  // Read only the first page, the same one the sidebar shows. Ancestors that
  // are not on it load one at a time below.
  const workspaceList = useInfiniteQuery({
    ...workspaceListOptions,
    staleTime: 5_000,
    enabled: Boolean(enabled && currentWorktreeId),
  });
  const rows = useMemo<WorkspaceListRow[]>(
    () => workspaceList.data?.pages.flatMap(page => page.workspaces) ?? [],
    [workspaceList.data?.pages]
  );
  const rowById = useMemo(
    () => new Map(rows.flatMap(row => (row.worktreeId ? [[row.worktreeId, row] as const] : []))),
    [rows]
  );

  const currentBatches = useMemo(
    () => worktreeDetailsBatches([currentWorktreeId]),
    [currentWorktreeId]
  );
  const currentDetailQueries = useQueries({
    queries: currentBatches.map(worktreeIds =>
      withRefresh(
        trpc.cliSessionsV2.worktreeDetails.queryOptions(
          { worktreeIds, organizationId: organizationId ?? null },
          { enabled: Boolean(enabled && currentWorktreeId) }
        ),
        refreshToken
      )
    ),
    combine: queries => {
      const worktrees: Record<string, WorktreeDetail> = {};
      for (const query of queries) Object.assign(worktrees, query.data?.worktrees ?? {});
      return worktrees;
    },
  });

  const currentDetailsById = currentDetailQueries;

  // A workspace merged or closed more than five days ago is absent from the
  // list, so walk up its durable parent links one missing layer at a time.
  const ancestorDetailsQuery = useQuery({
    queryKey: [
      'chat-stack-ancestor-details',
      userId,
      organizationId ?? null,
      currentWorktreeId,
      refreshToken,
      rows.length,
    ] as const,
    queryFn: async () => {
      const details: Record<string, WorktreeDetail> = {};
      if (!currentWorktreeId) return details;

      const seen = new Set<string>();
      let currentId: string | null = currentWorktreeId;
      while (currentId && !seen.has(currentId) && seen.size < MAX_STACK_ANCESTRY) {
        seen.add(currentId);
        const row = rowById.get(currentId);
        const loaded: WorktreeDetail | undefined =
          currentDetailsById[currentId] ?? details[currentId];
        if (!row && !loaded) {
          const worktreeIds = worktreeDetailsBatches([currentId])[0];
          if (!worktreeIds || worktreeIds.length === 0) break;
          const result = await trpcClient.cliSessionsV2.worktreeDetails.query({
            worktreeIds,
            organizationId: organizationId ?? null,
          });
          const detail = result.worktrees[currentId];
          if (!detail) break;
          details[currentId] = detail;
        }
        currentId =
          row?.parentWorktreeId ??
          loaded?.parentWorktreeId ??
          details[currentId]?.parentWorktreeId ??
          null;
      }
      return details;
    },
    enabled: Boolean(enabled && currentWorktreeId && workspaceList.isSuccess),
    staleTime: 30_000,
    retry: false,
  });

  const detailsById = useMemo(
    () => ({ ...currentDetailsById, ...(ancestorDetailsQuery.data ?? {}) }),
    [ancestorDetailsQuery.data, currentDetailsById]
  );

  const currentFallback = useMemo<WorkspaceInfo | null>(() => {
    if (!currentWorktreeId) return null;
    return {
      worktreeId: currentWorktreeId,
      name: null,
      defaultTitle: null,
      branch: branch ?? null,
      parentWorktreeId: null,
      baseBranch: null,
      gitUrl: gitUrl ?? null,
      repositoryKey: repositoryKey({ gitUrl, repository }),
      pr: null,
      latestSessionId: null,
      rootSessionId: null,
      prSessionId: null,
      prSessionCloudAgentSessionId: null,
      folderId: null,
    };
  }, [branch, currentWorktreeId, gitUrl, repository]);

  const infoById = useMemo(() => {
    const result = new Map<string, WorkspaceInfo>();
    for (const row of rows) {
      const workspace = rowWorkspace(row);
      if (workspace.worktreeId) result.set(workspace.worktreeId, workspace);
    }
    for (const [worktreeId, detail] of Object.entries(detailsById)) {
      const merged = mergeWorkspace(result.get(worktreeId), detailWorkspace(worktreeId, detail));
      if (merged) result.set(worktreeId, merged);
    }
    if (currentFallback && !result.has(currentFallback.worktreeId)) {
      result.set(currentFallback.worktreeId, currentFallback);
    }
    return result;
  }, [currentFallback, detailsById, rows]);

  const stackNodes = useMemo(() => [...infoById.values()].map(stackNode), [infoById]);
  const selection = useMemo(
    () => selectWorkspaceStack(stackNodes, currentWorktreeId),
    [currentWorktreeId, stackNodes]
  );
  const operationWorkspaces = useMemo(() => {
    const fromStack = (selection.stack?.entries ?? []).flatMap(entry => {
      const workspace = infoById.get(entry.node.worktreeId);
      return workspace ? [{ workspace, depth: entry.depth }] : [];
    });
    if (fromStack.length > 0) return fromStack;
    return selection.ancestorIds.flatMap((worktreeId, depth) => {
      const workspace = infoById.get(worktreeId);
      return workspace ? [{ workspace, depth }] : [];
    });
  }, [infoById, selection]);
  const ancestorWorkspaces = useMemo(
    () =>
      selection.ancestorIds.flatMap(worktreeId => {
        const workspace = infoById.get(worktreeId);
        return workspace ? [workspace] : [];
      }),
    [infoById, selection.ancestorIds]
  );

  const currentWorkspace =
    ancestorWorkspaces[ancestorWorkspaces.length - 1] ??
    (currentWorktreeId ? (infoById.get(currentWorktreeId) ?? null) : null);
  const parentWorkspace =
    ancestorWorkspaces.length > 1
      ? (ancestorWorkspaces[ancestorWorkspaces.length - 2] ?? null)
      : null;

  const sessionIdsToResolve = useMemo(
    () => [
      ...new Set(
        operationWorkspaces.flatMap(({ workspace }) => {
          if (
            workspace.worktreeId === currentWorktreeId ||
            workspace.prSessionCloudAgentSessionId
          ) {
            return [];
          }
          const sessionId = workspaceSessionId(workspace);
          return sessionId ? [sessionId] : [];
        })
      ),
    ],
    [currentWorktreeId, operationWorkspaces]
  );
  const sessionLookupQueries = useQueries({
    queries: sessionIdsToResolve.map(sessionId =>
      withRefresh(
        trpc.cliSessionsV2.get.queryOptions(
          { session_id: sessionId },
          { staleTime: 30_000, retry: false }
        ),
        refreshToken
      )
    ),
    combine: queries => {
      const result = new Map<string, SessionLookup>();
      for (const query of queries) {
        if (query.data) result.set(query.data.session_id, query.data);
      }
      return result;
    },
  });

  const cloudSessionIdFor = (workspace: WorkspaceInfo): string | null => {
    if (workspace.worktreeId === currentWorktreeId) return cloudAgentSessionId || null;
    if (workspace.prSessionCloudAgentSessionId) return workspace.prSessionCloudAgentSessionId;
    const sessionId = workspaceSessionId(workspace);
    return sessionId ? (sessionLookupQueries.get(sessionId)?.cloud_agent_session_id ?? null) : null;
  };

  const parentCloudSessionId = parentWorkspace ? cloudSessionIdFor(parentWorkspace) : null;
  const currentSnapshotQuery = useQuery({
    queryKey: [
      'chat-stack-current-changes',
      userId,
      organizationId ?? null,
      cloudAgentSessionId,
      refreshToken,
    ] as const,
    queryFn: () =>
      organizationId
        ? trpcClient.organizations.cloudAgentNext.getWorktreeChanges.query({
            organizationId,
            cloudAgentSessionId,
          })
        : trpcClient.cloudAgentNext.getWorktreeChanges.query({ cloudAgentSessionId }),
    enabled: Boolean(enabled && cloudAgentSessionId),
    staleTime: 5_000,
    retry: false,
  });
  const parentSnapshotQuery = useQuery({
    queryKey: [
      'chat-stack-parent-changes',
      userId,
      organizationId ?? null,
      parentCloudSessionId,
      refreshToken,
    ] as const,
    queryFn: () =>
      organizationId
        ? trpcClient.organizations.cloudAgentNext.getWorktreeChanges.query({
            organizationId,
            cloudAgentSessionId: parentCloudSessionId ?? '',
          })
        : trpcClient.cloudAgentNext.getWorktreeChanges.query({
            cloudAgentSessionId: parentCloudSessionId ?? '',
          }),
    enabled: Boolean(enabled && currentWorktreeId && parentCloudSessionId),
    staleTime: 5_000,
    retry: false,
  });

  const currentSnapshot = currentSnapshotQuery.data?.snapshot;
  const parentSnapshot = parentSnapshotQuery.data?.snapshot;
  const parentHead = parentSnapshot?.comparison.head ?? parentWorkspace?.pr?.headSha ?? null;
  const currentBase = shortBranchRef(currentSnapshot?.comparison.baseRef);
  const parentBranch = shortBranchRef(parentWorkspace?.branch);
  const behindParent = Boolean(
    parentWorkspace &&
    currentSnapshot &&
    parentHead &&
    parentBranch &&
    currentBase === parentBranch &&
    currentSnapshot.comparison.mergeBase !== parentHead
  );

  const branchOperations = useMemo<ChatStackInfo['branchOperations']>(() => {
    if (!currentWorktreeId) return undefined;
    const targets: WorktreeBranchOperationTarget[] = operationWorkspaces.flatMap(
      ({ workspace }, index) => {
        const cloudId = cloudSessionIdFor(workspace);
        if (!workspace.worktreeId || !workspace.branch || !cloudId) return [];
        return [
          {
            worktreeId: workspace.worktreeId,
            cloudAgentSessionId: cloudId,
            branch: workspace.branch,
            baseBranch: workspace.baseBranch,
            label: workspaceLabel(workspace),
            prNumber: workspace.pr?.number ?? null,
            prState: workspace.pr?.state ?? null,
            prUrl: workspace.pr?.url ?? null,
            stackNumber: workspace.pr?.stackNumber ?? null,
            stackPosition: workspace.pr?.stackPosition ?? index,
            isRoot: index === 0,
          },
        ];
      }
    );
    const currentTarget = targets.find(target => target.worktreeId === currentWorktreeId);
    if (!currentTarget) return undefined;
    return {
      worktreeId: currentWorktreeId,
      cloudAgentSessionId: currentTarget.cloudAgentSessionId,
      branch: currentTarget.branch,
      baseBranch: currentTarget.baseBranch,
      stack: targets,
    };
  }, [cloudAgentSessionId, currentWorktreeId, operationWorkspaces, sessionLookupQueries]);

  if (!enabled) return null;

  const currentBranch = currentWorkspace?.branch ?? branch ?? null;
  const canCreateStackedWorkspace = Boolean(currentWorktreeId && currentBranch);
  const entries = ancestorWorkspaces.map(workspace => ({
    worktreeId: workspace.worktreeId,
    label: workspaceLabel(workspace),
    prNumber: workspace.pr?.number ?? null,
    prState: workspace.pr?.state ?? null,
    prUrl: workspace.pr?.url ?? null,
    isCurrent: workspace.worktreeId === currentWorktreeId,
  }));

  const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
  const stackedWorktreeId = currentWorktreeId;
  const stackedBranch = currentBranch;
  return {
    entries,
    behindParent,
    canCreateStackedWorkspace,
    createStackedWorkspaceDisabledReason: !currentBranch
      ? stackedWorkspacePushReason(repository || 'this branch')
      : null,
    onCreateStackedWorkspace:
      canCreateStackedWorkspace && stackedWorktreeId && stackedBranch
        ? () => {
            setStackedWorkspaceTarget({
              worktreeId: stackedWorktreeId,
              branch: stackedBranch,
              repository: repository || currentWorkspace?.gitUrl || gitUrl || '',
              prNumber: currentWorkspace?.pr?.number ?? null,
              organizationId: organizationId ?? null,
            });
            if (pathname !== basePath) router.push(basePath);
          }
        : undefined,
    onOpenWorktree: (worktreeId: string) => {
      const workspace = infoById.get(worktreeId);
      const sessionId = workspace ? workspaceSessionId(workspace) : null;
      if (sessionId) openSession(sessionId);
    },
    branchOperations,
  } satisfies ChatStackInfo;
}
