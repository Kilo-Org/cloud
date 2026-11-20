import { useMemo, useState } from 'react';
import { skipToken, useInfiniteQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { CloudAgentWorktreeId } from '@kilocode/session-ingest-contracts';
import type { StoredSession } from '../types';
import type { WorkspaceSummary } from './useWorkspaceSummaries';
import { workspaceChatToStoredSession, workspaceSummaryChats } from './sidebar-workspace-model';

export function mergeWorkspaceChats(
  worktreeId: string | null,
  serverChats: readonly StoredSession[],
  pendingChats: readonly StoredSession[]
): StoredSession[] {
  if (!worktreeId) return [];
  const byId = new Map(serverChats.map(chat => [chat.sessionId, chat]));
  for (const chat of pendingChats) {
    if (chat.worktreeId === worktreeId && chat.localSync && !byId.has(chat.sessionId))
      byId.set(chat.sessionId, chat);
  }
  return [...byId.values()];
}

export function useWorkspaceChats({
  organizationId,
  worktreeId,
  workspace,
  pendingChats,
}: {
  organizationId: string | null;
  worktreeId: CloudAgentWorktreeId | null;
  workspace: WorkspaceSummary | undefined;
  pendingChats: readonly StoredSession[];
}) {
  const trpc = useTRPC();
  const [requestedHistoryId, setRequestedHistoryId] = useState<string | null>(null);
  const query = useInfiniteQuery({
    ...trpc.cliSessionsV2.workspaceChats.infiniteQueryOptions(
      worktreeId ? { organizationId, worktreeId, limit: 50 } : skipToken,
      { getNextPageParam: page => page.nextCursor ?? undefined }
    ),
    enabled: Boolean(worktreeId && requestedHistoryId === worktreeId),
    staleTime: 5_000,
  });
  const serverChats = useMemo(() => {
    if (!workspace) return [];
    const byId = new Map(workspaceSummaryChats(workspace).map(chat => [chat.sessionId, chat]));
    for (const chat of query.data?.pages.flatMap(page => page.chats) ?? []) {
      if (!byId.has(chat.sessionId))
        byId.set(chat.sessionId, workspaceChatToStoredSession(workspace, chat));
    }
    return [...byId.values()];
  }, [query.data?.pages, workspace]);
  const chats = useMemo(
    () => mergeWorkspaceChats(worktreeId, serverChats, pendingChats),
    [pendingChats, serverChats, worktreeId]
  );
  return {
    chats,
    serverChats,
    isLoading: query.isLoading,
    hasNextPage: query.hasNextPage,
    loadMore: () => {
      if (requestedHistoryId !== worktreeId) setRequestedHistoryId(worktreeId);
      else void query.fetchNextPage();
    },
  };
}
