'use client';

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import { formatSessionError } from '@kilocode/cloud-agent-sdk';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { startOfDay, subDays } from 'date-fns';
import { extractRepoFromGitUrl } from './utils/git-utils';
import { ChatSidebar } from './ChatSidebar';
import { SetPageActions } from '@/components/SetPageActions';
import { CloudAgentSettingsButton } from './settings/CloudAgentSettingsButton';
import {
  dbSessionToStoredSession,
  deriveForegroundSessionStatus,
  mergeWorktreeChatSessions,
  useSidebarSessions,
  type SidebarWorktreeDetails,
} from './hooks/useSidebarSessions';
import { useActiveSessions } from './hooks/useActiveSessions';
import {
  apiSessionToDbSession,
  dbSessionsAtom,
  deleteSessionFromStoreAtom,
} from './store/db-session-atoms';
import {
  getWorktreeDeletionRedirect,
  invalidateSessionQueries,
  removeDeletedSession,
} from './session-deletion';
import { useManager } from './CloudAgentProvider';
import type { StoredSession } from './types';
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
import { useSidebarPreferences } from './hooks/useSidebarPreferences';
import type { SidebarPreferences } from './sidebar-preferences';
import { useClosedWorktreeChatTabs } from './hooks/useClosedWorktreeChatTabs';
import { useWorkspaceFolders } from './hooks/useWorkspaceFolders';
import { createdOnPlatformForFilter } from './hooks/sidebar-queries';
import {
  getClosedWorktreeChatTabsStorageKey,
  getClosedWorktreeChatSessionIds,
  getNextOpenChatSessionId,
  getOpenWorktreeChatSessionIds,
  getWorktreeBranch,
} from './worktree-chat-tabs';
import type { ComposerFocusRequest } from './useSessionComposerFocus';
import {
  LocalSessionsProvider,
  useLocalSessions,
  type SendLocalSession,
} from './local-sessions/LocalSessionsProvider';
import {
  withLocalSessions,
  withLocalWorktreeDetails,
  type LocalComposerSettings,
} from './local-sessions/local-session';
import { sendLocalSessionRequest } from './local-sessions/local-session-request';
import { localSessionsStorageKey } from './local-sessions/local-session-storage';

// Context for children to toggle the mobile sidebar sheet
type WorktreeChatTabs = {
  currentSessionId: string | null;
  selectedWorktreeId: string | null;
  worktreeChats: StoredSession[];
  openWorktreeChats: StoredSession[];
  closedWorktreeChats: StoredSession[];
  openSession: (sessionId: string) => void;
  composerFocusRequest: ComposerFocusRequest | null;
  closeSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deletingSessionIds: string[];
  /** Retry a chat whose creation failed; it may continue under a new id. */
  retryLocalChat: (sessionId: string) => void;
  /** Drop a chat whose creation failed and close its tab. */
  discardLocalChat: (sessionId: string) => void;
};

const UNTITLED_WORKTREE_DETAILS: SidebarWorktreeDetails = {
  name: null,
  defaultTitle: null,
  prSession: null,
  sessions: [],
};

type SidebarLayoutContextValue = WorktreeChatTabs & {
  toggleMobileSidebar: () => void;
  /** Opens a new chat in the source chat's worktree at once; the server creates it in the background. */
  createWorktreeChat: (
    sourceKiloSessionId: string,
    options?: { placement?: 'append' | 'replace'; composer?: LocalComposerSettings | null }
  ) => void;
};

const SidebarLayoutContext = createContext<SidebarLayoutContextValue>({
  currentSessionId: null,
  selectedWorktreeId: null,
  worktreeChats: [],
  openWorktreeChats: [],
  closedWorktreeChats: [],
  openSession: () => {},
  composerFocusRequest: null,
  closeSession: () => {},
  renameSession: async () => {},
  deletingSessionIds: [],
  retryLocalChat: () => {},
  discardLocalChat: () => {},
  toggleMobileSidebar: () => {},
  createWorktreeChat: () => {},
});

export function useSidebarToggle() {
  return useContext(SidebarLayoutContext);
}

export function useWorktreeChatCreation() {
  const { createWorktreeChat } = useContext(SidebarLayoutContext);
  return { createWorktreeChat };
}

export function useWorktreeChatTabs(): WorktreeChatTabs {
  const {
    currentSessionId,
    selectedWorktreeId,
    worktreeChats,
    openWorktreeChats,
    closedWorktreeChats,
    openSession,
    composerFocusRequest,
    closeSession,
    renameSession,
    deletingSessionIds,
    retryLocalChat,
    discardLocalChat,
  } = useContext(SidebarLayoutContext);
  return {
    currentSessionId,
    selectedWorktreeId,
    worktreeChats,
    openWorktreeChats,
    closedWorktreeChats,
    openSession,
    composerFocusRequest,
    closeSession,
    renameSession,
    deletingSessionIds,
    retryLocalChat,
    discardLocalChat,
  };
}

type CloudSidebarLayoutProps = {
  currentUserId: string;
  organizationId?: string;
  /** Computed on the server, so the sidebar list matches its server prefetch. */
  sidebarUpdatedSince?: string;
  /** Read by the server from the cookie, so the first render uses the saved choices. */
  sidebarPreferences?: SidebarPreferences | null;
  children: ReactNode;
};

export function CloudSidebarLayout(props: CloudSidebarLayoutProps) {
  const { currentUserId, organizationId } = props;
  const router = useRouter();
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const send = useCallback<SendLocalSession>(
    async (session, attempt) => {
      const serverId = await sendLocalSessionRequest(
        trpcClient,
        session.request,
        session.organizationId,
        attempt
      );
      void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
      void queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter());
      return serverId;
    },
    [queryClient, trpc, trpcClient]
  );
  const followServerSession = useCallback(
    (localId: string, serverId: string) => {
      if (new URLSearchParams(window.location.search).get('sessionId') !== localId) return;
      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      router.replace(`${basePath}/chat?sessionId=${serverId}`);
    },
    [organizationId, router]
  );
  return (
    <LocalSessionsProvider
      key={`${currentUserId}:${organizationId ?? 'personal'}`}
      storageKey={localSessionsStorageKey(currentUserId, organizationId ?? null)}
      send={send}
      onAdopted={followServerSession}
    >
      <CloudSidebarLayoutContent {...props} />
    </LocalSessionsProvider>
  );
}

function CloudSidebarLayoutContent({
  currentUserId,
  organizationId,
  sidebarUpdatedSince,
  sidebarPreferences,
  children,
}: CloudSidebarLayoutProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentSessionId = searchParams.get('sessionId') ?? undefined;
  const worktreeIdFromParams = searchParams.get('worktreeId');
  const { platformFilter, setPlatformFilter, projectFilter, setProjectFilter, ...collapsed } =
    useSidebarPreferences(sidebarPreferences ?? null, {
      userId: currentUserId,
      organizationId: organizationId ?? null,
    });
  const workspaceFolders = useWorkspaceFolders(currentUserId, organizationId, collapsed);
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
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState<ComposerFocusRequest | null>(
    null
  );
  const [sessionPendingDeletion, setSessionPendingDeletion] = useState<string>();
  const [worktreePendingDeletion, setWorktreePendingDeletion] = useState<string>();
  const [deletingWorktreeIds, setDeletingWorktreeIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const {
    localSessions,
    createLocalSession,
    retryLocalSession,
    discardLocalSession,
    settleLocalSessions,
  } = useLocalSessions();
  const repoUpdatedSince = useMemo(() => startOfDay(subDays(new Date(), 30)).toISOString(), []);

  const createdOnPlatform = useMemo(
    () => createdOnPlatformForFilter(platformFilter),
    [platformFilter]
  );

  const folderWorktreeIds = useMemo(
    () => workspaceFolders.folders.flatMap(folder => folder.worktreeIds),
    [workspaceFolders.folders]
  );
  const {
    sessions: listedSessions,
    cachedSessions: listedCachedSessions,
    worktreeDetails,
    loadingWorktreeIds,
    isLoading: isLoadingSessions,
    refetchSessions,
    renameSessionLocally,
  } = useSidebarSessions({
    organizationId: organizationId ?? null,
    updatedSince: sidebarUpdatedSince,
    searchQuery,
    createdOnPlatform,
    gitUrl: projectFilter.length > 0 ? projectFilter : undefined,
    folderWorktreeIds,
  });
  // Chats this client created show from the first frame, until the server lists
  // them. They follow the sidebar's filters, as the server's list does.
  const filteredLocalSessions = useMemo(() => {
    const repositories = projectFilter.map(gitUrl => extractRepoFromGitUrl(gitUrl) ?? gitUrl);
    return localSessions.filter(
      session =>
        (!createdOnPlatform || createdOnPlatform.includes('cloud-agent-web')) &&
        (repositories.length === 0 || repositories.includes(session.repository))
    );
  }, [createdOnPlatform, localSessions, projectFilter]);
  const sessions = useMemo(
    () =>
      searchQuery
        ? listedSessions
        : withLocalSessions(listedSessions, filteredLocalSessions, organizationId ?? null),
    [filteredLocalSessions, listedSessions, organizationId, searchQuery]
  );
  const cachedSessions = useMemo(
    () => withLocalSessions(listedCachedSessions, localSessions, organizationId ?? null),
    [listedCachedSessions, localSessions, organizationId]
  );
  const sidebarWorktreeDetails = useMemo(
    () =>
      withLocalWorktreeDetails(
        worktreeDetails,
        sessions,
        new Set(localSessions.map(session => session.kiloSessionId)),
        UNTITLED_WORKTREE_DETAILS
      ),
    [localSessions, sessions, worktreeDetails]
  );
  const sidebarLoadingWorktreeIds = useMemo(
    () =>
      sidebarWorktreeDetails === worktreeDetails
        ? loadingWorktreeIds
        : loadingWorktreeIds.filter(id => !(id in sidebarWorktreeDetails) || id in worktreeDetails),
    [loadingWorktreeIds, sidebarWorktreeDetails, worktreeDetails]
  );
  const sidebarWorkspaceFolders = {
    ...workspaceFolders,
    refresh: async () => {
      refetchSessions();
      await workspaceFolders.refresh();
    },
  };
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
  const foregroundSession = useMemo(
    () =>
      currentSessionId && foregroundSessionStatus !== null
        ? { sessionId: currentSessionId, status: foregroundSessionStatus }
        : null,
    [currentSessionId, foregroundSessionStatus]
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

  useEffect(() => {
    if (localSessions.length === 0) return;
    // A filtered-out chat is never listed, so once synced it has nothing to wait for.
    const listedIds = new Set([
      ...listedCachedSessions.map(session => session.sessionId),
      ...(worktreeSessionsData?.cliSessions.map(session => session.session_id) ?? []),
      ...localSessions
        .filter(
          session => session.sync.state === 'synced' && !filteredLocalSessions.includes(session)
        )
        .map(session => session.kiloSessionId),
    ]);
    settleLocalSessions(listedIds, currentSessionId ?? null);
  }, [
    currentSessionId,
    filteredLocalSessions,
    listedCachedSessions,
    localSessions,
    settleLocalSessions,
    worktreeSessionsData?.cliSessions,
  ]);

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
        await queryClient.invalidateQueries(trpc.workspaceFolders.list.pathFilter());
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

  const openSessionInternal = useCallback(
    (sessionId: string, options?: { replace?: boolean }) => {
      openChatTab(sessionId);
      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      const chatPath = `${basePath}/chat`;
      const targetUrl = `${chatPath}?sessionId=${sessionId}`;
      if (pathname === chatPath && isNewSession(sessionId)) {
        window.history[options?.replace ? 'replaceState' : 'pushState'](null, '', targetUrl);
      } else if (options?.replace) {
        router.replace(targetUrl);
      } else {
        router.push(targetUrl);
      }
      setMobileSheetOpen(false);
    },
    [openChatTab, organizationId, pathname, router]
  );

  const selectSession = useCallback(
    (sessionId: string) => {
      startTransition(() => {
        if (sessionId !== currentSessionId) {
          const request: ComposerFocusRequest = {
            sessionId,
            onHandled: () =>
              setComposerFocusRequest(current => (current === request ? null : current)),
          };
          setComposerFocusRequest(request);
        }
        openSessionInternal(sessionId);
      });
    },
    [currentSessionId, openSessionInternal]
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
        openSessionInternal(nextSessionId);
      } else {
        openWorktree(selectedWorktreeId);
      }
    },
    [
      closeChatTab,
      currentSessionId,
      openSessionInternal,
      openWorktree,
      openWorktreeChats,
      selectedWorktreeId,
      worktreeChats,
    ]
  );

  const discardLocalChat = useCallback(
    (sessionId: string) => {
      const session = localSessions.find(item => item.kiloSessionId === sessionId);
      if (session?.worktreeId) {
        closeSession(sessionId);
      } else if (sessionId === currentSessionId) {
        // A new session goes back to the form, which gets its prompt back.
        router.replace(organizationId ? `/organizations/${organizationId}/cloud` : '/cloud');
      }
      discardLocalSession(sessionId);
    },
    [closeSession, currentSessionId, discardLocalSession, localSessions, organizationId, router]
  );

  const handleCreateWorktreeChat = useCallback(
    (
      sourceKiloSessionId: string,
      {
        placement = 'append',
        composer = null,
      }: { placement?: 'append' | 'replace'; composer?: LocalComposerSettings | null } = {}
    ) => {
      const knownChats = [...worktreeChats, ...cachedSessions];
      const source = knownChats.find(session => session.sessionId === sourceKiloSessionId);
      const worktreeId = source?.worktreeId ?? selectedWorktreeId;
      // The server copies the setup from a chat it has, so a local source defers to one.
      const serverSourceId = source?.localSync
        ? knownChats.find(session => session.worktreeId === worktreeId && !session.localSync)
            ?.sessionId
        : sourceKiloSessionId;
      if (!worktreeId || !serverSourceId) return;

      const kiloSessionId = createLocalSession({
        organizationId: organizationId ?? null,
        worktreeId,
        request: { kind: 'worktree-chat', sourceKiloSessionId: serverSourceId },
        // Chats of a worktree share its repository and branch.
        repository:
          source?.repository ||
          knownChats.find(chat => chat.worktreeId === worktreeId && chat.repository)?.repository ||
          '',
        branch: source?.branch ?? getWorktreeBranch(worktreeId, knownChats),
        composer,
        firstMessage: null,
      });
      if (placement === 'replace' && worktreeId === selectedWorktreeId) {
        replaceChatTab(
          worktreeId,
          sourceKiloSessionId,
          kiloSessionId,
          openWorktreeChats.map(session => session.sessionId)
        );
      }
      openSessionInternal(kiloSessionId);
    },
    [
      cachedSessions,
      createLocalSession,
      openSessionInternal,
      openWorktreeChats,
      organizationId,
      replaceChatTab,
      selectedWorktreeId,
      worktreeChats,
    ]
  );

  const retryLocalChat = useCallback(
    (sessionId: string) => {
      const nextSessionId = retryLocalSession(sessionId);
      if (!nextSessionId || nextSessionId === sessionId) return;
      if (selectedWorktreeId) {
        replaceChatTab(
          selectedWorktreeId,
          sessionId,
          nextSessionId,
          openWorktreeChats.map(session => session.sessionId)
        );
      }
      if (sessionId === currentSessionId) openSessionInternal(nextSessionId, { replace: true });
    },
    [
      currentSessionId,
      openSessionInternal,
      openWorktreeChats,
      replaceChatTab,
      retryLocalSession,
      selectedWorktreeId,
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
        openSessionInternal(survivingWorktreeChat.sessionId);
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
    openSessionInternal,
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

  const handleConfirmWorktreeDelete = useCallback(() => {
    const worktreeId = worktreePendingDeletion;
    if (!worktreeId || deletingWorktreeIds.has(worktreeId)) return;

    setWorktreePendingDeletion(undefined);
    setDeletingWorktreeIds(previous => new Set(previous).add(worktreeId));

    void (async () => {
      try {
        const { deletedSessionIds } = await deleteWorktree({
          worktreeId: cloudAgentWorktreeIdSchema.parse(worktreeId),
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
        forgetWorktreeTabs(worktreeId, deletedSessionIds);
        const redirect = getWorktreeDeletionRedirect(
          new URL(window.location.href),
          worktreeId,
          deletedSessionIds,
          organizationId
        );
        if (redirect) router.push(redirect);
        void invalidateSessionQueries({ queryClient, trpc });
        void queryClient.invalidateQueries(trpc.workspaceFolders.list.pathFilter());
        toast.success('Worktree deleted');
      } catch (error) {
        toast.error('Failed to delete worktree', { description: formatSessionError(error) });
        void invalidateSessionQueries({ queryClient, trpc });
        void queryClient.invalidateQueries(trpc.workspaceFolders.list.pathFilter());
      } finally {
        setDeletingWorktreeIds(previous => {
          const next = new Set(previous);
          next.delete(worktreeId);
          return next;
        });
      }
    })();
  }, [
    deleteSessionFromStore,
    deleteWorktree,
    deletingWorktreeIds,
    forgetWorktreeTabs,
    organizationId,
    queryClient,
    router,
    setDbSessions,
    trpc,
    worktreePendingDeletion,
  ]);

  const deletingWorktreeIdList = useMemo(() => [...deletingWorktreeIds], [deletingWorktreeIds]);
  const toggleMobileSidebar = useCallback(() => setMobileSheetOpen(prev => !prev), []);
  const sidebarContext = useMemo(
    () => ({
      currentSessionId: currentSessionId ?? null,
      selectedWorktreeId,
      worktreeChats,
      openWorktreeChats,
      closedWorktreeChats,
      openSession: selectSession,
      composerFocusRequest,
      closeSession,
      renameSession: handleRenameSession,
      deletingSessionIds,
      retryLocalChat,
      discardLocalChat,
      toggleMobileSidebar,
      createWorktreeChat: handleCreateWorktreeChat,
    }),
    [
      currentSessionId,
      selectedWorktreeId,
      worktreeChats,
      openWorktreeChats,
      closedWorktreeChats,
      selectSession,
      composerFocusRequest,
      closeSession,
      handleRenameSession,
      deletingSessionIds,
      retryLocalChat,
      discardLocalChat,
      toggleMobileSidebar,
      handleCreateWorktreeChat,
    ]
  );

  // Stable so the topbar is not rewritten on every render of this layout.
  const topbarActions = useMemo(
    () => <CloudAgentSettingsButton organizationId={organizationId} />,
    [organizationId]
  );

  return (
    <SidebarLayoutContext.Provider value={sidebarContext}>
      <SetPageActions>{topbarActions}</SetPageActions>
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
              key={`mobile:${currentUserId}:${organizationId ?? 'personal'}`}
              workspaceFolders={sidebarWorkspaceFolders}
              sessions={sidebarSessions}
              currentSessionId={currentSessionId}
              selectedWorktreeId={selectedWorktreeId}
              onOpenSession={selectSession}
              organizationId={organizationId}
              onDeleteSession={setSessionPendingDeletion}
              onRenameSession={handleRenameSession}
              worktreeDetails={sidebarWorktreeDetails}
              loadingWorktreeIds={sidebarLoadingWorktreeIds}
              isLoading={isLoadingSessions}
              onRenameWorktree={handleRenameWorktree}
              onDeleteWorktree={setWorktreePendingDeletion}
              deletingWorktreeIds={deletingWorktreeIdList}
              onCreateWorktreeChat={handleCreateWorktreeChat}
              isInSheet
              activeSessions={activeSessions}
              foregroundSession={foregroundSession}
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
            key={`desktop:${currentUserId}:${organizationId ?? 'personal'}`}
            workspaceFolders={sidebarWorkspaceFolders}
            sessions={sidebarSessions}
            currentSessionId={currentSessionId}
            selectedWorktreeId={selectedWorktreeId}
            onOpenSession={selectSession}
            organizationId={organizationId}
            onDeleteSession={setSessionPendingDeletion}
            onRenameSession={handleRenameSession}
            worktreeDetails={sidebarWorktreeDetails}
            loadingWorktreeIds={sidebarLoadingWorktreeIds}
            isLoading={isLoadingSessions}
            onRenameWorktree={handleRenameWorktree}
            onDeleteWorktree={setWorktreePendingDeletion}
            deletingWorktreeIds={deletingWorktreeIdList}
            onCreateWorktreeChat={handleCreateWorktreeChat}
            activeSessions={activeSessions}
            foregroundSession={foregroundSession}
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
          if (!open) setWorktreePendingDeletion(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete worktree?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes every chat and the worktree’s files, stops its running work,
              and cleans up its sandbox resources. Other worktrees are not affected. Deletion
              continues in the background.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmWorktreeDelete}>
              Delete worktree
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarLayoutContext.Provider>
  );
}
