'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSetAtom } from 'jotai';
import { usePathname, useRouter } from 'next/navigation';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import type { ChatStackInfo } from './ChatHeader';
import { stackedWorkspaceTargetAtom } from './store/stacked-workspace-atoms';
import { useWorkspaceSummaryLookup, type WorkspaceSummary } from './hooks/useWorkspaceSummaries';
import { repositoryKey, shortBranchRef } from './worktree-meta';
import { stackedWorkspacePushReason } from './stacked-workspace-preparation';
import { useSavedWorktreeChanges } from './useSavedWorktreeChanges';
import type { WorktreeBranchOperationTarget } from './useWorktreeBranchOperations';
import {
  selectWorkspaceStack,
  type WorkspaceStackNode,
  type WorkspaceStackPr,
} from './workspace-stacks';

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
  latestOpenSessionId: string | null;
  prSessionCloudAgentSessionId: string | null;
};

function rowWorkspace(row: WorkspaceSummary): WorkspaceInfo {
  return {
    worktreeId: row.worktreeId,
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
    latestOpenSessionId: row.latestOpenSessionId,
    prSessionCloudAgentSessionId: row.cloudAgentSessionId,
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
  const trpcClient = useRawTRPCClient();
  const router = useRouter();
  const pathname = usePathname();
  const setStackedWorkspaceTarget = useSetAtom(stackedWorkspaceTargetAtom);
  const requestedWorktreeIds = useMemo(
    () => (currentWorktreeId ? [currentWorktreeId] : []),
    [currentWorktreeId]
  );
  const { workspaces: rows } = useWorkspaceSummaryLookup({
    organizationId: organizationId ?? null,
    worktreeIds: requestedWorktreeIds,
    enabled,
  });

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
      latestOpenSessionId: null,
      prSessionCloudAgentSessionId: null,
    };
  }, [branch, currentWorktreeId, gitUrl, repository]);

  const infoById = useMemo(() => {
    const result = new Map<string, WorkspaceInfo>();
    for (const row of rows) {
      const workspace = rowWorkspace(row);
      if (workspace.worktreeId) result.set(workspace.worktreeId, workspace);
    }
    if (currentFallback && !result.has(currentFallback.worktreeId)) {
      result.set(currentFallback.worktreeId, currentFallback);
    }
    return result;
  }, [currentFallback, rows]);

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

  const cloudSessionIdFor = (workspace: WorkspaceInfo): string | null => {
    if (workspace.worktreeId === currentWorktreeId) return cloudAgentSessionId || null;
    return workspace.prSessionCloudAgentSessionId;
  };

  const parentCloudSessionId = parentWorkspace ? cloudSessionIdFor(parentWorkspace) : null;
  const { saved: currentSnapshotQuery } = useSavedWorktreeChanges({
    userId,
    organizationId,
    cloudAgentSessionId,
    worktreeId: currentWorktreeId ?? undefined,
    refreshToken,
    enabled: Boolean(enabled && cloudAgentSessionId && parentWorkspace),
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
  }, [cloudAgentSessionId, currentWorktreeId, operationWorkspaces]);

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
      const sessionId = workspace?.latestOpenSessionId;
      if (sessionId) openSession(sessionId);
      else router.push(`${basePath}/chat?worktreeId=${worktreeId}`);
    },
    branchOperations,
  } satisfies ChatStackInfo;
}
