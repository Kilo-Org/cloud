'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
} from '@tanstack/react-query';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import type { WorkspaceSummary } from '@/lib/cloud-agent/workspace-read-model';
import {
  legacyWorkspaceTabImport,
  patchWorkspaceChatTabs,
  reduceWorktreeChatTabs,
  workspaceChatTabsState,
  type WorktreeChatTabsAction,
} from '../worktree-chat-tabs';

type TabAction = Exclude<WorktreeChatTabsAction, { type: 'forgetWorktree' }>;
type WorkspaceQueryData = { workspaces: WorkspaceSummary[] };
type WorkspaceCacheData = WorkspaceQueryData | InfiniteData<WorkspaceQueryData>;
type PendingAction = { id: number; action: TabAction };
type Options = {
  organizationId: string | null;
  workspaces: readonly WorkspaceSummary[];
  onChanged?: (worktreeIds: readonly string[]) => void | Promise<void>;
};

function cachedWorkspaces(data: WorkspaceCacheData | undefined): WorkspaceSummary[] {
  if (!data) return [];
  return 'pages' in data ? data.pages.flatMap(page => page.workspaces) : data.workspaces;
}

function mapCachedWorkspaces(
  data: WorkspaceCacheData,
  update: (workspace: WorkspaceSummary) => WorkspaceSummary
): WorkspaceCacheData {
  return 'pages' in data
    ? {
        ...data,
        pages: data.pages.map(page => ({ ...page, workspaces: page.workspaces.map(update) })),
      }
    : { ...data, workspaces: data.workspaces.map(update) };
}

function actionWorkspace(action: TabAction, workspaces: readonly WorkspaceSummary[]) {
  const hasChat = (workspace: WorkspaceSummary, id: string) =>
    workspace.openChats.some(chat => chat.sessionId === id) ||
    workspace.closedChats.some(chat => chat.sessionId === id);
  return workspaces.find(workspace => {
    if (action.type === 'replace') {
      return (
        workspace.worktreeId === action.worktreeId &&
        hasChat(workspace, action.oldSessionId) &&
        hasChat(workspace, action.newSessionId)
      );
    }
    if (action.type === 'reorder') {
      return (
        workspace.worktreeId === action.worktreeId &&
        hasChat(workspace, action.sessionId) &&
        (action.beforeSessionId === null || hasChat(workspace, action.beforeSessionId))
      );
    }
    return hasChat(workspace, action.sessionId);
  });
}

export function useClosedWorktreeChatTabs(
  storageKey: string | null,
  { organizationId, workspaces, onChanged }: Options
) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const scopeKey = JSON.stringify([storageKey, organizationId]);
  const { mutateAsync: closeTab } = useMutation(
    trpc.cliSessionsV2.closeWorkspaceTab.mutationOptions()
  );
  const { mutateAsync: reopenTab } = useMutation(
    trpc.cliSessionsV2.reopenWorkspaceTab.mutationOptions()
  );
  const { mutateAsync: reorderTab } = useMutation(
    trpc.cliSessionsV2.reorderWorkspaceTab.mutationOptions()
  );
  const { mutateAsync: replaceTab } = useMutation(
    trpc.cliSessionsV2.replaceWorkspaceTab.mutationOptions()
  );
  const { mutateAsync: importTabs } = useMutation(
    trpc.cliSessionsV2.importWorkspaceTabs.mutationOptions()
  );
  const [pending, setPending] = useState<{ scopeKey: string; actions: PendingAction[] }>({
    scopeKey,
    actions: [],
  });
  const nextId = useRef(0);
  const dispatched = useRef(new Set<number>());
  const activeMutations = useRef(new Map<string, number>());
  const writes = useRef(new Map<string, Promise<void>>());
  const current = useRef({ workspaces, onChanged, scopeKey });
  current.current = { workspaces, onChanged, scopeKey };
  const [readyScopes, setReadyScopes] = useState<ReadonlySet<string>>(new Set());
  const importAttempts = useRef(new Set<string>());
  const imports = useRef(new Map<string, Promise<void>>());

  const refresh = useCallback(
    async (worktreeIds: readonly string[]) => {
      const ids = [...new Set(worktreeIds)].map(id => cloudAgentWorktreeIdSchema.parse(id));
      for (let offset = 0; offset < ids.length; offset += 200) {
        const result = await queryClient.fetchQuery({
          ...trpc.cliSessionsV2.workspaceSummaries.queryOptions({
            organizationId,
            worktreeIds: ids.slice(offset, offset + 200),
          }),
          staleTime: 0,
        });
        const byId = new Map(result.workspaces.map(workspace => [workspace.worktreeId, workspace]));
        for (const filter of [
          trpc.cliSessionsV2.listWorkspaces.pathFilter(),
          trpc.cliSessionsV2.workspaceSummaries.pathFilter(),
        ]) {
          for (const [queryKey, data] of queryClient.getQueriesData<WorkspaceCacheData>(filter)) {
            if (!data || !cachedWorkspaces(data).some(workspace => byId.has(workspace.worktreeId)))
              continue;
            queryClient.setQueryData(
              queryKey,
              mapCachedWorkspaces(data, workspace => byId.get(workspace.worktreeId) ?? workspace)
            );
          }
        }
      }
      if (current.current.scopeKey === scopeKey) await current.current.onChanged?.(worktreeIds);
    },
    [organizationId, queryClient, scopeKey, trpc]
  );

  const run = useCallback(
    async (action: TabAction, workspace: WorkspaceSummary) => {
      const worktreeId = cloudAgentWorktreeIdSchema.parse(workspace.worktreeId);
      const mutationKey = `${organizationId}:${worktreeId}`;
      activeMutations.current.set(mutationKey, (activeMutations.current.get(mutationKey) ?? 0) + 1);
      const finishMutation = async () => {
        const remaining = (activeMutations.current.get(mutationKey) ?? 1) - 1;
        if (remaining > 0) activeMutations.current.set(mutationKey, remaining);
        else {
          activeMutations.current.delete(mutationKey);
          await refresh([worktreeId]).catch(() => undefined);
        }
      };
      const filters = [
        trpc.cliSessionsV2.listWorkspaces.pathFilter(),
        trpc.cliSessionsV2.workspaceSummaries.pathFilter(),
      ];
      const snapshots: {
        queryKey: QueryKey;
        previous: WorkspaceSummary;
        patched: WorkspaceSummary;
      }[] = [];
      let write: Promise<void> | undefined;
      try {
        if (!imports.current.has(scopeKey)) {
          await Promise.all(filters.map(filter => queryClient.cancelQueries(filter)));
        }
        for (const filter of filters) {
          for (const [queryKey, data] of queryClient.getQueriesData<WorkspaceCacheData>(filter)) {
            const previous = cachedWorkspaces(data).find(row => row.worktreeId === worktreeId);
            if (!data || !previous) continue;
            const patched = patchWorkspaceChatTabs(previous, action);
            const result = queryClient.setQueryData<WorkspaceCacheData>(
              queryKey,
              mapCachedWorkspaces(data, row => (row === previous ? patched : row))
            );
            const stored = cachedWorkspaces(result).find(row => row.worktreeId === worktreeId);
            if (stored) snapshots.push({ queryKey, previous, patched: stored });
          }
        }
        const base = { organizationId, worktreeId };
        write = (writes.current.get(mutationKey) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            try {
              await imports.current.get(scopeKey);
              switch (action.type) {
                case 'close':
                  await closeTab({ ...base, sessionId: action.sessionId });
                  break;
                case 'open':
                  await reopenTab({ ...base, sessionId: action.sessionId });
                  break;
                case 'reorder':
                  await reorderTab({
                    ...base,
                    sessionId: action.sessionId,
                    beforeSessionId: action.beforeSessionId,
                  });
                  break;
                case 'replace':
                  await replaceTab({
                    ...base,
                    oldSessionId: action.oldSessionId,
                    newSessionId: action.newSessionId,
                  });
                  break;
              }
            } finally {
              await finishMutation();
            }
          });
        writes.current.set(mutationKey, write);
        await write;
      } catch {
        for (const { queryKey, previous, patched } of snapshots) {
          queryClient.setQueryData<WorkspaceCacheData>(queryKey, data =>
            data ? mapCachedWorkspaces(data, row => (row === patched ? previous : row)) : data
          );
        }
        toast.error('Could not save chat tabs. Please try again.');
      } finally {
        if (!write) await finishMutation();
        if (writes.current.get(mutationKey) === write) writes.current.delete(mutationKey);
      }
    },
    [
      closeTab,
      organizationId,
      queryClient,
      refresh,
      reopenTab,
      reorderTab,
      replaceTab,
      scopeKey,
      trpc,
    ]
  );

  const update = useCallback(
    (action: TabAction) => {
      if (current.current.scopeKey !== scopeKey) return;
      const id = ++nextId.current;
      setPending(value => {
        let actions = value.scopeKey === scopeKey ? value.actions : [];
        let nextAction = action;
        if (action.type === 'replace') {
          const previous = actions.find(
            entry =>
              !dispatched.current.has(entry.id) &&
              entry.action.type === 'replace' &&
              entry.action.worktreeId === action.worktreeId &&
              entry.action.newSessionId === action.oldSessionId
          );
          if (previous?.action.type === 'replace') {
            nextAction = { ...previous.action, newSessionId: action.newSessionId };
            actions = actions.filter(
              entry =>
                entry.id !== previous.id &&
                !(
                  (entry.action.type === 'open' || entry.action.type === 'close') &&
                  entry.action.sessionId === action.oldSessionId
                )
            );
          }
        }
        return { scopeKey, actions: [...actions, { id, action: nextAction }].slice(-1_000) };
      });
    },
    [scopeKey]
  );

  useEffect(() => {
    if (pending.scopeKey !== scopeKey) return;
    for (const entry of pending.actions) {
      if (dispatched.current.has(entry.id)) continue;
      const workspace = actionWorkspace(entry.action, workspaces);
      if (!workspace) continue;
      dispatched.current.add(entry.id);
      void run(entry.action, workspace).finally(() => {
        dispatched.current.delete(entry.id);
        setPending(value =>
          value.scopeKey === scopeKey
            ? {
                scopeKey,
                actions: value.actions.filter(action => action.id !== entry.id),
              }
            : value
        );
      });
    }
  }, [pending, run, scopeKey, workspaces]);

  useLayoutEffect(() => {
    if (importAttempts.current.has(scopeKey)) return;
    importAttempts.current.add(scopeKey);
    let rawLegacy: string | null = null;
    try {
      rawLegacy = storageKey === null ? null : window.localStorage.getItem(storageKey);
    } catch {
      setReadyScopes(value => new Set([...value, scopeKey]));
      return;
    }
    if (rawLegacy === null) {
      setReadyScopes(value => new Set([...value, scopeKey]));
      return;
    }
    const tabs = legacyWorkspaceTabImport(rawLegacy);
    const importing = importTabs({ organizationId, ...tabs })
      .then(async result => {
        await refresh(result.worktreeIds);
        try {
          if (storageKey !== null) window.localStorage.removeItem(storageKey);
        } catch {
          // A blocked storage keeps the legacy key; the server merge is idempotent.
        }
      })
      .catch(() => {
        toast.error('Could not import saved chat tabs. The browser copy was not changed.');
      })
      .finally(() => {
        imports.current.delete(scopeKey);
        setReadyScopes(value => new Set([...value, scopeKey]));
      });
    imports.current.set(scopeKey, importing);
  }, [importTabs, organizationId, refresh, scopeKey, storageKey]);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted)
        void refresh(current.current.workspaces.map(workspace => workspace.worktreeId));
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [refresh]);

  const tabs = useMemo(() => {
    let state = workspaceChatTabsState(workspaces);
    for (const entry of pending.scopeKey === scopeKey ? pending.actions : []) {
      state = reduceWorktreeChatTabs(state, entry.action);
    }
    return state;
  }, [pending, scopeKey, workspaces]);

  const openChatTab = useCallback(
    (sessionId: string) => update({ type: 'open', sessionId }),
    [update]
  );
  const closeChatTab = useCallback(
    (sessionId: string) => update({ type: 'close', sessionId }),
    [update]
  );
  const replaceChatTab = useCallback(
    (
      worktreeId: string,
      oldSessionId: string,
      newSessionId: string,
      openSessionIds: readonly string[]
    ) => update({ type: 'replace', worktreeId, oldSessionId, newSessionId, openSessionIds }),
    [update]
  );
  const reorderChatTab = useCallback(
    (worktreeId: string, sessionId: string, beforeSessionId: string | null) => {
      const workspace = current.current.workspaces.find(row => row.worktreeId === worktreeId);
      update({
        type: 'reorder',
        worktreeId,
        sessionId,
        beforeSessionId,
        openSessionIds: workspace?.openChats.map(chat => chat.sessionId) ?? [],
      });
    },
    [update]
  );
  const forgetWorktreeTabs = useCallback((worktreeId: string, sessionIds: readonly string[]) => {
    const forgotten = new Set(sessionIds);
    setPending(value => ({
      ...value,
      actions: value.actions.filter(({ action }) =>
        action.type === 'replace' || action.type === 'reorder'
          ? action.worktreeId !== worktreeId
          : !forgotten.has(action.sessionId)
      ),
    }));
  }, []);

  return {
    ...tabs,
    openChatTab,
    closeChatTab,
    replaceChatTab,
    reorderChatTab,
    forgetWorktreeTabs,
    isReady: readyScopes.has(scopeKey),
  };
}
