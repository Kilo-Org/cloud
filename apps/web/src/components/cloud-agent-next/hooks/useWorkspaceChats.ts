import { useCallback, useEffect, useMemo, useRef } from 'react';
import { skipToken, useInfiniteQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { CloudAgentWorktreeId } from '@kilocode/session-ingest-contracts';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import type { StoredSession } from '../types';
import type { WorkspaceSummary } from './useWorkspaceSummaries';

type ChatPage = inferRouterOutputs<RootRouter>['cliSessionsV2']['workspaceChats'];
const WORKSPACE_CHAT_PAGE_SIZE = 200;

function withWorkspaceChatPages(workspace: WorkspaceSummary, pages: readonly ChatPage[]) {
  const chats = [
    ...new Map(
      pages.flatMap(page => page.chats.map(chat => [chat.sessionId, chat] as const))
    ).values(),
  ];
  const position = (value: number | null) => value ?? Number.MAX_SAFE_INTEGER;
  return {
    ...workspace,
    openChats: chats
      .filter(chat => chat.closedPosition === null)
      .sort((a, b) => position(a.tabPosition) - position(b.tabPosition)),
    closedChats: chats
      .filter(chat => chat.closedPosition !== null)
      .sort((a, b) => position(a.closedPosition) - position(b.closedPosition)),
  };
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
}: {
  organizationId: string | null;
  worktreeId: CloudAgentWorktreeId | null;
  workspace: WorkspaceSummary | undefined;
}) {
  const trpc = useTRPC();
  const needsPages = Boolean(worktreeId && workspace?.chatTabsTruncated);
  const { data, fetchNextPage, hasNextPage, isError, isFetchNextPageError, isFetching, refetch } =
    useInfiniteQuery({
      ...trpc.cliSessionsV2.workspaceChats.infiniteQueryOptions(
        worktreeId ? { organizationId, worktreeId, limit: WORKSPACE_CHAT_PAGE_SIZE } : skipToken,
        { getNextPageParam: page => page.nextCursor ?? undefined }
      ),
      enabled: needsPages,
      gcTime: 60_000,
    });
  useEffect(() => {
    if (needsPages && hasNextPage && !isFetching && !isError) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isError, isFetching, needsPages]);

  const snapshot = useRef<{ key: string; revision: string } | null>(null);
  const key = JSON.stringify([organizationId, worktreeId]);
  const revision = `${workspace?.chatTabsRevision}:${workspace?.chatCount}`;
  useEffect(() => {
    const previous = snapshot.current;
    snapshot.current = needsPages ? { key, revision } : null;
    if (needsPages && previous?.key === key && previous.revision !== revision) void refetch();
  }, [key, needsPages, refetch, revision]);

  const waitingForPages = needsPages && (!data || hasNextPage);
  const workspaceWithTabs = useMemo(
    () =>
      needsPages && workspace && data && !hasNextPage
        ? withWorkspaceChatPages(workspace, data.pages)
        : workspace,
    [data, hasNextPage, needsPages, workspace]
  );
  const retry = useCallback(() => {
    void (isFetchNextPageError ? fetchNextPage() : refetch());
  }, [fetchNextPage, isFetchNextPageError, refetch]);
  return {
    workspaceWithTabs,
    waitingForPages,
    hasError: needsPages && isError,
    retry,
  };
}
