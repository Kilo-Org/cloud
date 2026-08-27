'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  skipToken,
  useQuery,
  useQueryClient,
  useMutation,
  useMutationState,
} from '@tanstack/react-query';
import { useAtomValue, useSetAtom } from 'jotai';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { formatSessionError } from '@kilocode/cloud-agent-sdk';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { useTRPC } from '@/lib/trpc/utils';
import { startOfDay, subDays } from 'date-fns';
import { extractRepoFromGitUrl } from './utils/git-utils';
import { ChatSidebar } from './ChatSidebar';
import {
  dbSessionToStoredSession,
  deriveForegroundSessionStatus,
  mergeWorktreeChatSessions,
  useSidebarSessions,
} from './hooks/useSidebarSessions';
import { useActiveSessions } from './hooks/useActiveSessions';
import {
  apiSessionToDbSession,
  dbSessionsAtom,
  deleteSessionFromStoreAtom,
} from './store/db-session-atoms';
import { invalidateSessionQueries, removeDeletedSession } from './session-deletion';
import { useManager } from './CloudAgentProvider';
import {
  getCloudSessionCreationOperation,
  isAmbiguousCloudSessionCreationError,
  type CloudSessionCreationOperation,
  type StoredSession,
} from './types';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useClosedWorktreeChatTabs } from './hooks/useClosedWorktreeChatTabs';
import {
  getClosedWorktreeChatTabsStorageKey,
  getClosedWorktreeChatSessionIds,
  getNextOpenChatSessionId,
  getOpenWorktreeChatSessionIds,
} from './worktree-chat-tabs';

// Context for children to toggle the mobile sidebar sheet
type WorktreeChatTabs = {
  currentSessionId: string | null;
  selectedWorktreeId: string | null;
  worktreeChats: StoredSession[];
  openWorktreeChats: StoredSession[];
  closedWorktreeChats: StoredSession[];
  openSession: (sessionId: string) => void;
  closeSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deletingSessionIds: string[];
};

type SidebarLayoutContextValue = WorktreeChatTabs & {
  toggleMobileSidebar: () => void;
  createWorktreeChat: (
    sourceKiloSessionId: string,
    placement?: 'append' | 'replace'
  ) => Promise<boolean>;
  creatingWorktreeSourceSessionId: string | null;
};

type PendingWorktreeCreationOperation = CloudSessionCreationOperation & {
  placement: 'append' | 'replace';
  promise: Promise<boolean> | null;
};

const SidebarLayoutContext = createContext<SidebarLayoutContextValue>({
  currentSessionId: null,
  selectedWorktreeId: null,
  worktreeChats: [],
  openWorktreeChats: [],
  closedWorktreeChats: [],
  openSession: () => {},
  closeSession: () => {},
  renameSession: async () => {},
  deletingSessionIds: [],
  toggleMobileSidebar: () => {},
  createWorktreeChat: async () => false,
  creatingWorktreeSourceSessionId: null,
});

export function useSidebarToggle() {
  return useContext(SidebarLayoutContext);
}

export function useWorktreeChatCreation() {
  const { createWorktreeChat, creatingWorktreeSourceSessionId } = useContext(SidebarLayoutContext);
  return { createWorktreeChat, creatingWorktreeSourceSessionId };
}

export function useWorktreeChatTabs(): WorktreeChatTabs {
  const {
    currentSessionId,
    selectedWorktreeId,
    worktreeChats,
    openWorktreeChats,
    closedWorktreeChats,
    openSession,
    closeSession,
    renameSession,
    deletingSessionIds,
  } = useContext(SidebarLayoutContext);
  return {
    currentSessionId,
    selectedWorktreeId,
    worktreeChats,
    openWorktreeChats,
    closedWorktreeChats,
    openSession,
    closeSession,
    renameSession,
    deletingSessionIds,
  };
}

type CloudSidebarLayoutProps = {
  currentUserId: string;
  organizationId?: string;
  children: ReactNode;
};

export function CloudSidebarLayout({
  currentUserId,
  organizationId,
  children,
}: CloudSidebarLayoutProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentSessionId = searchParams.get('sessionId') ?? undefined;
  const worktreeIdFromParams = searchParams.get('worktreeId');
  const {
    closedSessionIds,
    sessionOrderByWorktree,
    openChatTab,
    closeChatTab,
    replaceChatTab,
    forgetWorktreeTabs,
  } = useClosedWorktreeChatTabs(getClosedWorktreeChatTabsStorageKey(currentUserId, organizationId));

  useEffect(() => {
    if (currentSessionId) openChatTab(currentSessionId);
  }, [currentSessionId, openChatTab]);

  const manager = useManager();
  const activity = useAtomValue(manager.atoms.activity);
  const isStreaming = useAtomValue(manager.atoms.isStreaming);
  const activeQuestion = useAtomValue(manager.atoms.activeQuestion);
  const activePermission = useAtomValue(manager.atoms.activePermission);
  const cloudStatus = useAtomValue(manager.atoms.cloudStatus);
  const pendingMessages = useAtomValue(manager.atoms.pendingMessages);
  const activeSessionType = useAtomValue(manager.atoms.activeSessionType);
  const fetchedSessionData = useAtomValue(manager.atoms.fetchedSessionData);

  const [searchQuery, setSearchQuery] = useState('');
  const projectFilterKey = `cloud-sessions:project-filter:${organizationId ?? 'personal'}`;
  const [platformFilter, setPlatformFilter] = useLocalStorage<string[]>(
    'cloud-sessions:platform-filter',
    ['cloud-agent'],
    { initializeWithValue: false }
  );
  const [projectFilter, setProjectFilter] = useLocalStorage<string[]>(projectFilterKey, [], {
    initializeWithValue: false,
  });
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [sessionPendingDeletion, setSessionPendingDeletion] = useState<string>();
  const [worktreePendingDeletion, setWorktreePendingDeletion] = useState<string>();
  const [deletingWorktreeId, setDeletingWorktreeId] = useState<string>();
  const [creatingWorktreeSourceSessionId, setCreatingWorktreeSourceSessionId] = useState<
    string | null
  >(null);
  const pendingWorktreeCreationRef = useRef<PendingWorktreeCreationOperation | null>(null);
  const repoUpdatedSince = useMemo(() => startOfDay(subDays(new Date(), 30)).toISOString(), []);

  const createdOnPlatform = useMemo(() => {
    if (platformFilter.length === 0) return undefined;
    return platformFilter.flatMap(p => {
      switch (p) {
        // 'cloud-agent-web' is a variant of the cloud agent
        case 'cloud-agent':
          return ['cloud-agent', 'cloud-agent-web'];
        // Extension sessions are created from VS Code or agent-manager
        case 'extension':
          return ['vscode', 'agent-manager'];
        default:
          return [p];
      }
    });
  }, [platformFilter]);

  const { sessions, cachedSessions, worktreeDetails, refetchSessions, renameSessionLocally } =
    useSidebarSessions({
      organizationId: organizationId ?? null,
      searchQuery,
      createdOnPlatform,
      gitUrl: projectFilter.length > 0 ? projectFilter : undefined,
    });
  const foregroundSessionStatus = useMemo(
    () =>
      deriveForegroundSessionStatus({
        currentSessionId: currentSessionId ?? null,
        organizationId: organizationId ?? null,
        activeSessionType,
        fetchedSessionData,
        activity,
        isStreaming,
        activeQuestion,
        activePermission,
        cloudStatus,
        pendingMessages,
      }),
    [
      activePermission,
      activeQuestion,
      activeSessionType,
      activity,
      cloudStatus,
      currentSessionId,
      fetchedSessionData,
      isStreaming,
      organizationId,
      pendingMessages,
    ]
  );
  const sidebarSessions = useMemo(() => {
    if (foregroundSessionStatus === null) return sessions;
    return sessions.map(session =>
      session.sessionId === currentSessionId && session.sessionStatus !== foregroundSessionStatus
        ? { ...session, sessionStatus: foregroundSessionStatus }
        : session
    );
  }, [currentSessionId, foregroundSessionStatus, sessions]);
  const { activeSessions } = useActiveSessions();

  // Session deletion (lightweight - no stream cleanup, container handles that on unmount)
  const trpc = useTRPC();
  const selectedWorktreeId = useMemo(() => {
    if (!currentSessionId) {
      const parsedWorktreeId = cloudAgentWorktreeIdSchema.safeParse(worktreeIdFromParams);
      return parsedWorktreeId.success ? parsedWorktreeId.data : null;
    }

    const cachedSession = cachedSessions.find(session => session.sessionId === currentSessionId);
    const fetchedWorktreeId =
      fetchedSessionData?.kiloSessionId === currentSessionId &&
      fetchedSessionData.organizationId === (organizationId ?? null)
        ? fetchedSessionData.worktreeId
        : null;
    const parsedWorktreeId = cloudAgentWorktreeIdSchema.safeParse(
      cachedSession?.worktreeId ?? fetchedWorktreeId
    );
    return parsedWorktreeId.success ? parsedWorktreeId.data : null;
  }, [cachedSessions, currentSessionId, fetchedSessionData, organizationId, worktreeIdFromParams]);
  const { data: worktreeSessionsData } = useQuery(
    trpc.cliSessionsV2.list.queryOptions(
      selectedWorktreeId
        ? {
            organizationId: organizationId ?? null,
            worktreeId: selectedWorktreeId,
            limit: 200,
            orderBy: 'updated_at',
          }
        : skipToken
    )
  );
  const worktreeChats = useMemo(() => {
    if (!selectedWorktreeId) return [];

    const authoritativeSessions =
      worktreeSessionsData?.cliSessions
        .filter(session => session.organization_id === (organizationId ?? null))
        .map(session => dbSessionToStoredSession(apiSessionToDbSession(session))) ?? [];
    const mergedSessions = mergeWorktreeChatSessions(
      selectedWorktreeId,
      authoritativeSessions,
      cachedSessions
    );
    if (foregroundSessionStatus === null) return mergedSessions;
    return mergedSessions.map(session =>
      session.sessionId === currentSessionId && session.sessionStatus !== foregroundSessionStatus
        ? { ...session, sessionStatus: foregroundSessionStatus }
        : session
    );
  }, [
    cachedSessions,
    currentSessionId,
    foregroundSessionStatus,
    organizationId,
    selectedWorktreeId,
    worktreeSessionsData?.cliSessions,
  ]);
  const openWorktreeChats = useMemo(() => {
    const sessionsById = new Map(worktreeChats.map(session => [session.sessionId, session]));
    const openSessionIds = getOpenWorktreeChatSessionIds(
      [...sessionsById.keys()],
      closedSessionIds,
      selectedWorktreeId ? sessionOrderByWorktree[selectedWorktreeId] : undefined
    );
    return openSessionIds.flatMap(sessionId => {
      const session = sessionsById.get(sessionId);
      return session ? [session] : [];
    });
  }, [closedSessionIds, selectedWorktreeId, sessionOrderByWorktree, worktreeChats]);
  const closedWorktreeChats = useMemo(() => {
    const sessionsById = new Map(worktreeChats.map(session => [session.sessionId, session]));
    return getClosedWorktreeChatSessionIds([...sessionsById.keys()], closedSessionIds).flatMap(
      sessionId => {
        const session = sessionsById.get(sessionId);
        return session ? [session] : [];
      }
    );
  }, [closedSessionIds, worktreeChats]);

  const { data: recentReposData } = useQuery({
    ...trpc.cliSessionsV2.recentRepositories.queryOptions({
      organizationId,
      updatedSince: repoUpdatedSince,
    }),
    staleTime: 60_000,
  });

  const recentProjects = useMemo(() => {
    if (!recentReposData?.repositories) return [];
    return recentReposData.repositories
      .map(r => ({
        gitUrl: r.gitUrl,
        displayName: extractRepoFromGitUrl(r.gitUrl) ?? r.gitUrl,
      }))
      .filter(r => r.displayName);
  }, [recentReposData?.repositories]);
  const queryClient = useQueryClient();
  const setDbSessions = useSetAtom(dbSessionsAtom);
  const deleteSessionFromStore = useSetAtom(deleteSessionFromStoreAtom);

  const { mutate: deleteCliSessionV2 } = useMutation(
    trpc.cliSessionsV2.delete.mutationOptions({
      onSuccess: async (_data, { session_id: sessionId }) => {
        await removeDeletedSession({
          sessionId,
          queryClient,
          trpc,
          setDbSessions,
          deleteSessionFromStore,
        });
        toast('Session deleted successfully');
        await invalidateSessionQueries({ queryClient, trpc });
      },
      onError: error => {
        console.error('Error calling session deletion API:', error);
        toast.error('Failed to delete session. Please try again.');
        void invalidateSessionQueries({ queryClient, trpc });
      },
    })
  );
  const deletingSessionIds = useMutationState({
    filters: { mutationKey: trpc.cliSessionsV2.delete.mutationKey(), status: 'pending' },
    select: mutation =>
      (mutation.state.variables as Parameters<typeof deleteCliSessionV2>[0]).session_id,
  });
  const { mutateAsync: renameCliSessionV2 } = useMutation(
    trpc.cliSessionsV2.rename.mutationOptions()
  );
  const { mutateAsync: renameWorktree } = useMutation(
    trpc.cliSessionsV2.renameWorktree.mutationOptions()
  );
  const { mutateAsync: deleteWorktree } = useMutation(
    trpc.cliSessionsV2.deleteWorktree.mutationOptions()
  );
  const { mutateAsync: createPersonalWorktreeChat } = useMutation(
    trpc.cloudAgentNext.createWorktreeChat.mutationOptions()
  );
  const { mutateAsync: createOrganizationWorktreeChat } = useMutation(
    trpc.organizations.cloudAgentNext.createWorktreeChat.mutationOptions()
  );

  const openSession = useCallback(
    (sessionId: string) => {
      openChatTab(sessionId);
      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      const chatPath = `${basePath}/chat`;
      const targetUrl = `${chatPath}?sessionId=${sessionId}`;
      if (pathname === chatPath && isNewSession(sessionId)) {
        window.history.pushState(null, '', targetUrl);
      } else {
        router.push(targetUrl);
      }
      setMobileSheetOpen(false);
    },
    [openChatTab, organizationId, pathname, router]
  );

  const openWorktree = useCallback(
    (worktreeId: string) => {
      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      const chatPath = `${basePath}/chat`;
      const targetUrl = `${chatPath}?worktreeId=${worktreeId}`;
      if (pathname === chatPath) {
        window.history.pushState(null, '', targetUrl);
      } else {
        router.push(targetUrl);
      }
      setMobileSheetOpen(false);
    },
    [organizationId, pathname, router]
  );

  const closeSession = useCallback(
    (sessionId: string) => {
      if (!selectedWorktreeId || !worktreeChats.some(session => session.sessionId === sessionId)) {
        return;
      }
      closeChatTab(sessionId);
      if (sessionId !== currentSessionId) return;

      const nextSessionId = getNextOpenChatSessionId(
        openWorktreeChats.map(session => session.sessionId),
        sessionId
      );
      if (nextSessionId) {
        openSession(nextSessionId);
      } else {
        openWorktree(selectedWorktreeId);
      }
    },
    [
      closeChatTab,
      currentSessionId,
      openSession,
      openWorktree,
      openWorktreeChats,
      selectedWorktreeId,
      worktreeChats,
    ]
  );

  const handleCreateWorktreeChat = useCallback(
    (sourceKiloSessionId: string, placement: 'append' | 'replace' = 'append'): Promise<boolean> => {
      const intent = JSON.stringify({
        sourceKiloSessionId,
        organizationId: organizationId ?? null,
      });
      const pending = pendingWorktreeCreationRef.current;
      if (pending?.promise) {
        return pending.intent === intent && pending.placement === placement
          ? pending.promise
          : Promise.resolve(false);
      }

      const operation = getCloudSessionCreationOperation(pending, intent, uuidv4);
      setCreatingWorktreeSourceSessionId(sourceKiloSessionId);

      const request = (async () => {
        try {
          const input = { sourceKiloSessionId, operationKey: operation.operationKey };
          const result = organizationId
            ? await createOrganizationWorktreeChat({ ...input, organizationId })
            : await createPersonalWorktreeChat(input);

          if (pendingWorktreeCreationRef.current?.operationKey === operation.operationKey) {
            pendingWorktreeCreationRef.current = null;
          }

          void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
          void queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter());

          if (placement === 'replace') {
            replaceChatTab(
              result.worktreeId,
              sourceKiloSessionId,
              result.kiloSessionId,
              openWorktreeChats.map(session => session.sessionId)
            );
          }
          openSession(result.kiloSessionId);
          return true;
        } catch (error) {
          if (
            !isAmbiguousCloudSessionCreationError(error) &&
            pendingWorktreeCreationRef.current?.operationKey === operation.operationKey
          ) {
            pendingWorktreeCreationRef.current = null;
          }
          toast.error('Failed to create chat', { description: formatSessionError(error) });
          return false;
        } finally {
          if (pendingWorktreeCreationRef.current?.operationKey === operation.operationKey) {
            pendingWorktreeCreationRef.current = { ...operation, placement, promise: null };
          }
          setCreatingWorktreeSourceSessionId(null);
        }
      })();

      pendingWorktreeCreationRef.current = { ...operation, placement, promise: request };
      return request;
    },
    [
      createOrganizationWorktreeChat,
      createPersonalWorktreeChat,
      openSession,
      openWorktreeChats,
      organizationId,
      queryClient,
      replaceChatTab,
      trpc.cliSessionsV2.list,
      trpc.cliSessionsV2.search,
    ]
  );

  const handleConfirmDelete = useCallback(() => {
    if (!sessionPendingDeletion || deletingSessionIds.includes(sessionPendingDeletion)) return;

    setSessionPendingDeletion(undefined);
    deleteCliSessionV2({ session_id: sessionPendingDeletion });
    if (sessionPendingDeletion === currentSessionId) {
      const survivingWorktreeChat = openWorktreeChats.find(
        session =>
          session.sessionId !== sessionPendingDeletion &&
          !deletingSessionIds.includes(session.sessionId)
      );
      if (survivingWorktreeChat) {
        openSession(survivingWorktreeChat.sessionId);
      } else if (
        selectedWorktreeId &&
        worktreeChats.some(
          session =>
            session.sessionId !== sessionPendingDeletion &&
            !deletingSessionIds.includes(session.sessionId)
        )
      ) {
        openWorktree(selectedWorktreeId);
      } else {
        const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
        router.replace(basePath);
      }
    }
  }, [
    sessionPendingDeletion,
    deletingSessionIds,
    deleteCliSessionV2,
    currentSessionId,
    openSession,
    openWorktree,
    openWorktreeChats,
    organizationId,
    router,
    selectedWorktreeId,
    worktreeChats,
  ]);

  const handleRenameSession = useCallback(
    async (sessionId: string, title: string) => {
      await renameCliSessionV2({ session_id: sessionId, title });
      renameSessionLocally(sessionId, title);
      void queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter());
      void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
      void queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter());
      refetchSessions();
    },
    [renameCliSessionV2, renameSessionLocally, queryClient, trpc, refetchSessions]
  );

  const handleRenameWorktree = useCallback(
    async (worktreeId: string, name: string) => {
      await renameWorktree({
        worktreeId: cloudAgentWorktreeIdSchema.parse(worktreeId),
        name,
        organizationId: organizationId ?? null,
      });
      await Promise.all([
        queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter()),
        queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter()),
      ]);
    },
    [organizationId, queryClient, renameWorktree, trpc]
  );

  const handleConfirmWorktreeDelete = useCallback(async () => {
    if (!worktreePendingDeletion || deletingWorktreeId) return;

    setDeletingWorktreeId(worktreePendingDeletion);
    try {
      const { deletedSessionIds } = await deleteWorktree({
        worktreeId: cloudAgentWorktreeIdSchema.parse(worktreePendingDeletion),
        organizationId: organizationId ?? null,
      });
      await Promise.all(
        deletedSessionIds.map(sessionId =>
          removeDeletedSession({
            sessionId,
            queryClient,
            trpc,
            setDbSessions,
            deleteSessionFromStore,
          })
        )
      );
      forgetWorktreeTabs(worktreePendingDeletion, deletedSessionIds);
      setWorktreePendingDeletion(undefined);
      if (
        selectedWorktreeId === worktreePendingDeletion ||
        (currentSessionId && deletedSessionIds.includes(currentSessionId))
      ) {
        router.push(organizationId ? `/organizations/${organizationId}/cloud` : '/cloud');
      }
      void invalidateSessionQueries({ queryClient, trpc });
      toast.success('Worktree deleted');
    } catch (error) {
      toast.error('Failed to delete worktree', { description: formatSessionError(error) });
    } finally {
      setDeletingWorktreeId(undefined);
    }
  }, [
    currentSessionId,
    deleteSessionFromStore,
    deleteWorktree,
    deletingWorktreeId,
    forgetWorktreeTabs,
    organizationId,
    queryClient,
    router,
    selectedWorktreeId,
    setDbSessions,
    trpc,
    worktreePendingDeletion,
  ]);

  return (
    <SidebarLayoutContext.Provider
      value={{
        currentSessionId: currentSessionId ?? null,
        selectedWorktreeId,
        worktreeChats,
        openWorktreeChats,
        closedWorktreeChats,
        openSession,
        closeSession,
        renameSession: handleRenameSession,
        deletingSessionIds,
        toggleMobileSidebar: () => setMobileSheetOpen(prev => !prev),
        createWorktreeChat: handleCreateWorktreeChat,
        creatingWorktreeSourceSessionId,
      }}
    >
      <div className="flex h-[calc(100dvh-3.5rem)] w-full overflow-hidden">
        {/* Mobile Sheet */}
        <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
          <SheetContent
            side="left"
            className="w-80 p-0 lg:hidden [@media(any-pointer:coarse)]:[&>button]:size-11"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Sessions</SheetTitle>
            </SheetHeader>
            <ChatSidebar
              sessions={sidebarSessions}
              currentSessionId={currentSessionId}
              selectedWorktreeId={selectedWorktreeId}
              onOpenSession={openSession}
              organizationId={organizationId}
              onDeleteSession={setSessionPendingDeletion}
              onRenameSession={handleRenameSession}
              worktreeDetails={worktreeDetails}
              onRenameWorktree={handleRenameWorktree}
              onDeleteWorktree={setWorktreePendingDeletion}
              deletingWorktreeId={deletingWorktreeId}
              onCreateWorktreeChat={handleCreateWorktreeChat}
              creatingWorktreeSourceSessionId={creatingWorktreeSourceSessionId}
              isInSheet
              activeSessions={activeSessions}
              deletingSessionIds={deletingSessionIds}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              platformFilter={platformFilter}
              onPlatformChange={setPlatformFilter}
              projectFilter={projectFilter}
              onProjectChange={setProjectFilter}
              recentProjects={recentProjects}
              onMobileSheetOpenChange={setMobileSheetOpen}
            />
          </SheetContent>
        </Sheet>

        {/* Desktop Sidebar */}
        <div className="hidden w-80 shrink-0 border-r lg:block">
          <ChatSidebar
            sessions={sidebarSessions}
            currentSessionId={currentSessionId}
            selectedWorktreeId={selectedWorktreeId}
            onOpenSession={openSession}
            organizationId={organizationId}
            onDeleteSession={setSessionPendingDeletion}
            onRenameSession={handleRenameSession}
            worktreeDetails={worktreeDetails}
            onRenameWorktree={handleRenameWorktree}
            onDeleteWorktree={setWorktreePendingDeletion}
            deletingWorktreeId={deletingWorktreeId}
            onCreateWorktreeChat={handleCreateWorktreeChat}
            creatingWorktreeSourceSessionId={creatingWorktreeSourceSessionId}
            activeSessions={activeSessions}
            deletingSessionIds={deletingSessionIds}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            platformFilter={platformFilter}
            onPlatformChange={setPlatformFilter}
            projectFilter={projectFilter}
            onProjectChange={setProjectFilter}
            recentProjects={recentProjects}
          />
        </div>

        {/* Main Content */}
        <div className="h-full min-w-0 flex-1 overflow-hidden">{children}</div>
      </div>
      <AlertDialog
        open={sessionPendingDeletion !== undefined}
        onOpenChange={open => {
          if (!open) {
            setSessionPendingDeletion(undefined);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete session?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the session and its history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmDelete}>
              Delete session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={worktreePendingDeletion !== undefined}
        onOpenChange={open => {
          if (!open && !deletingWorktreeId) setWorktreePendingDeletion(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete worktree?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes every chat and the worktree’s files, stops its running work,
              and cleans up its sandbox resources. Other worktrees are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingWorktreeId !== undefined}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deletingWorktreeId !== undefined}
              onClick={event => {
                event.preventDefault();
                void handleConfirmWorktreeDelete();
              }}
            >
              {deletingWorktreeId ? 'Deleting...' : 'Delete worktree'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarLayoutContext.Provider>
  );
}
