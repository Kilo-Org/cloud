import { useCallback, useMemo, useState } from 'react';
import { skipToken, useInfiniteQuery } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useTRPC } from '@/lib/trpc/utils';
import type { CloudAgentWorktreeId } from '@kilocode/session-ingest-contracts';
import type { StoredSession } from '../types';
import type { WorkspaceSummary } from './useWorkspaceSummaries';
import { workspaceChatToStoredSession } from './sidebar-workspace-model';

export const OPEN_CHAT_TAB_PAGE_SIZE = 50;
export const CLOSED_CHAT_TAB_PAGE_SIZE = 20;

export type ChatTabPages = {
  hasMore: boolean;
  loading: boolean;
  error: boolean;
  loadMore: () => void;
};

function tabOrderChanged(error: unknown): boolean {
  return error instanceof TRPCClientError && error.data?.code === 'CONFLICT';
}

function retryChatPage(failureCount: number, error: unknown): boolean {
  return !tabOrderChanged(error) && failureCount < 3;
}

function useChatTabPages(
  {
    hasNextPage,
    isFetching,
    isError,
    error,
    data,
    fetchNextPage,
    refetch,
  }: ReturnType<typeof useInfiniteQuery>,
  enabled = true
): ChatTabPages {
  const hasData = data !== undefined;
  const restartPaging = tabOrderChanged(error);
  const loadMore = useCallback(() => {
    if (!enabled || isFetching) return;
    if (hasData && hasNextPage && !restartPaging) void fetchNextPage();
    else void refetch();
  }, [enabled, fetchNextPage, hasData, hasNextPage, isFetching, refetch, restartPaging]);

  return useMemo(
    () => ({ hasMore: hasNextPage, loading: !enabled || isFetching, error: isError, loadMore }),
    [enabled, hasNextPage, isFetching, isError, loadMore]
  );
}

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
  currentSessionId,
}: {
  organizationId: string | null;
  worktreeId: CloudAgentWorktreeId | null;
  workspace: WorkspaceSummary | undefined;
  currentSessionId: string | null;
}) {
  const trpc = useTRPC();
  const [requestedHistory, setRequestedHistory] = useState<string | null>(null);
  const scope = worktreeId ? { organizationId, worktreeId } : null;
  const scopeKey = scope ? JSON.stringify(scope) : null;
  const historyRequested = scopeKey !== null && requestedHistory === scopeKey;
  const requestClosedHistory = useCallback(() => setRequestedHistory(scopeKey), [scopeKey]);
  const open = useInfiniteQuery({
    ...trpc.cliSessionsV2.workspaceChats.infiniteQueryOptions(
      scope ? { ...scope, tabState: 'open', limit: OPEN_CHAT_TAB_PAGE_SIZE } : skipToken,
      { getNextPageParam: page => page.nextCursor ?? undefined }
    ),
    staleTime: 5_000,
    retry: retryChatPage,
  });
  const closed = useInfiniteQuery({
    ...trpc.cliSessionsV2.workspaceChats.infiniteQueryOptions(
      scope ? { ...scope, tabState: 'closed', limit: CLOSED_CHAT_TAB_PAGE_SIZE } : skipToken,
      { getNextPageParam: page => page.nextCursor ?? undefined }
    ),
    enabled: historyRequested,
    staleTime: 5_000,
    retry: retryChatPage,
  });
  const currentInOpen = open.data?.pages.some(page =>
    page.chats.some(chat => chat.sessionId === currentSessionId)
  );
  const needsCurrent = currentInOpen === false || (currentInOpen === undefined && open.isError);
  const current = useInfiniteQuery({
    ...trpc.cliSessionsV2.workspaceChats.infiniteQueryOptions(
      scope && currentSessionId ? { ...scope, sessionId: currentSessionId, limit: 1 } : skipToken,
      { getNextPageParam: () => undefined }
    ),
    enabled: scope !== null && currentSessionId !== null && needsCurrent,
    staleTime: 5_000,
  });
  const { openChats, closedChats } = useMemo(() => {
    const openChats = open.data?.pages.flatMap(page => page.chats) ?? [];
    const closedChats = closed.data?.pages.flatMap(page => page.chats) ?? [];
    const active = current.data?.pages[0]?.chats[0];
    if (active && needsCurrent) {
      if (!active.tabClosed) openChats.push(active);
      else if (!closedChats.some(chat => chat.sessionId === active.sessionId))
        closedChats.push(active);
    }
    const openIds = new Set(openChats.map(chat => chat.sessionId));
    return {
      openChats,
      closedChats: closedChats.filter(chat => !openIds.has(chat.sessionId)),
    };
  }, [open.data, closed.data, current.data, needsCurrent]);
  const serverChats = useMemo(
    () =>
      workspace
        ? [...openChats, ...closedChats].map(chat => workspaceChatToStoredSession(workspace, chat))
        : [],
    [workspace, openChats, closedChats]
  );
  return {
    serverChats,
    openChats,
    closedChats,
    requestClosedHistory,
    openPages: useChatTabPages(open),
    closedPages: useChatTabPages(closed, historyRequested),
  };
}
