'use client';

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { skipToken, useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useAtomValue, useSetAtom } from 'jotai';
import { toast } from 'sonner';
import {
  cloudAgentWorktreeIdSchema,
  type CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';
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
  getDeletionErrorMessage,
  getWorktreeDeletionRedirect,
  invalidateSessionQueries,
  removeDeletedSessions,
  type SessionDeletionEvent,
} from './session-deletion';
import { useSessionDeletion } from './hooks/useSessionDeletion';
import { useManager } from './CloudAgentProvider';
import type { StoredSession } from './types';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { useResizableSidebar } from '@/hooks/useResizableSidebar';
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
  arriveAtChatAddress,
  getActiveChatSessionId,
  getClosedWorktreeChatTabsStorageKey,
  getClosedWorktreeChatSessionIds,
  getLatestOpenChatSessionId,
  getNextOpenChatSessionId,
  getOpenWorktreeChatSessionIds,
  getWorktreeBranch,
  isRestoredDocumentNavigation,
  requestChatNavigation,
  type PendingChatNavigation,
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
  type LocalSession,
} from './local-sessions/local-session';
import {
  releaseLocalSessionUploads,
  sendLocalSessionRequest,
} from './local-sessions/local-session-request';
import { localSessionsStorageKey } from './local-sessions/local-session-storage';

// Context for children to toggle the mobile sidebar sheet
type WorktreeChatTabs = {
  currentSessionId: string | null;
  selectedWorktreeId: CloudAgentWorktreeId | null;
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

let documentNavigationConsumed = false;

/** Only the first chat address a document shows can be the one it was restored with. */
function consumeRestoredDocumentNavigation(): boolean {
  if (documentNavigationConsumed) return false;
  documentNavigationConsumed = true;
  const navigation = performance
    .getEntriesByType('navigation')
    .find((entry): entry is PerformanceNavigationTiming => 'type' in entry);
  return isRestoredDocumentNavigation(
    navigation,
    window.location.href,
    'wasDiscarded' in document && document.wasDiscarded === true
  );
}

const UNTITLED_WORKTREE_DETAILS: SidebarWorktreeDetails = {
  name: null,
  defaultTitle: null,
  prSession: null,
  sessions: [],
};

const SESSIONS_SIDEBAR_MIN_WIDTH = 320;
const SESSIONS_SIDEBAR_MAX_WIDTH = 480;
const SESSIONS_SIDEBAR_KEYBOARD_STEP = 16;
const SESSIONS_SIDEBAR_STORAGE_KEY = 'cloud-agent:sessions-sidebar-width';

type SidebarLayoutContextValue = WorktreeChatTabs & {
  toggleMobileSidebar: () => void;
  /** Opens a new chat in the source chat's worktree at once; the server creates it in the background. */
  createWorktreeChat: (
    sourceKiloSessionId: string,
    options?: { placement?: 'append' | 'replace'; composer?: LocalComposerSettings | null }
  ) => boolean;
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
  createWorktreeChat: () => false,
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
  const releaseDiscardedUploads = useCallback(
    (session: LocalSession) => {
      void releaseLocalSessionUploads(trpcClient, session.request, currentUserId).catch(() => {});
    },
    [currentUserId, trpcClient]
  );
  return (
    <LocalSessionsProvider
      key={`${currentUserId}:${organizationId ?? 'personal'}`}
      storageKey={localSessionsStorageKey(currentUserId, organizationId ?? null)}
      send={send}
      onAdopted={followServerSession}
      onDiscard={releaseDiscardedUploads}
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
  const addressedSessionRef = useRef<{ sessionId: string | null } | null>(null);
  const pendingNavigationRef = useRef<PendingChatNavigation>(null);

  const manager = useManager();
  const activity = useAtomValue(manager.atoms.activity);
  const isStreaming = useAtomValue(manager.atoms.isStreaming);
  const activeQuestion = useAtomValue(manager.atoms.activeQuestion);
  const activePermission = useAtomValue(manager.atoms.activePermission);
  const cloudStatus = useAtomValue(manager.atoms.cloudStatus);
  const pendingMessages = useAtomValue(manager.atoms.pendingMessages);
  const agentStatus = useAtomValue(manager.atoms.agentStatus);
  const activeSessionType = useAtomValue(manager.atoms.activeSessionType);
  const fetchedSessionData = useAtomValue(manager.atoms.fetchedSessionData);

  const [searchQuery, setSearchQuery] = useState('');
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState<ComposerFocusRequest | null>(
    null
  );
  const [worktreePendingDeletion, setWorktreePendingDeletion] = useState<string>();
  const [deletingWorktreeIds, setDeletingWorktreeIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const {
    width: sessionsSidebarWidth,
    startDrag: startSessionsSidebarDrag,
    resizeTo: resizeSessionsSidebar,
  } = useResizableSidebar(
    SESSIONS_SIDEBAR_MIN_WIDTH,
    SESSIONS_SIDEBAR_MIN_WIDTH,
    SESSIONS_SIDEBAR_MAX_WIDTH,
    SESSIONS_SIDEBAR_STORAGE_KEY
  );
  const handleSessionsSidebarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number;
    switch (event.key) {
      case 'ArrowLeft':
        nextWidth = sessionsSidebarWidth - SESSIONS_SIDEBAR_KEYBOARD_STEP;
        break;
      case 'ArrowRight':
        nextWidth = sessionsSidebarWidth + SESSIONS_SIDEBAR_KEYBOARD_STEP;
        break;
      case 'Home':
        nextWidth = SESSIONS_SIDEBAR_MIN_WIDTH;
        break;
      case 'End':
        nextWidth = SESSIONS_SIDEBAR_MAX_WIDTH;
        break;
      default:
        return;
    }
    event.preventDefault();
    resizeSessionsSidebar(nextWidth);
  };
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
        agentStatus,
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
      agentStatus,
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
      session.sessionId === currentSessionId
        ? {
            ...session,
            sessionStatus: foregroundSessionStatus,
            latestRunTerminalAt:
              foregroundSessionStatus === 'idle' ? session.latestRunTerminalAt : null,
          }
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
      session.sessionId === currentSessionId
        ? {
            ...session,
            sessionStatus: foregroundSessionStatus,
            latestRunTerminalAt:
              foregroundSessionStatus === 'idle' ? session.latestRunTerminalAt : null,
          }
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
      pendingNavigationRef.current = requestChatNavigation(pendingNavigationRef.current, sessionId);
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

  const focusComposerForSession = useCallback((sessionId: string) => {
    const request: ComposerFocusRequest = {
      sessionId,
      onHandled: () => setComposerFocusRequest(current => (current === request ? null : current)),
    };
    setComposerFocusRequest(request);
  }, []);

  const selectSession = useCallback(
    (sessionId: string) => {
      startTransition(() => {
        if (sessionId !== currentSessionId) focusComposerForSession(sessionId);
        openSessionInternal(sessionId);
      });
    },
    [currentSessionId, focusComposerForSession, openSessionInternal]
  );

  const openWorktree = useCallback(
    (worktreeId: string, options?: { replace?: boolean }) => {
      pendingNavigationRef.current = requestChatNavigation(pendingNavigationRef.current, null);
      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      const chatPath = `${basePath}/chat`;
      const targetUrl = `${chatPath}?worktreeId=${worktreeId}`;
      if (pathname === chatPath) {
        window.history[options?.replace ? 'replaceState' : 'pushState'](null, '', targetUrl);
      } else if (options?.replace) {
        router.replace(targetUrl);
      } else {
        router.push(targetUrl);
      }
      setMobileSheetOpen(false);
    },
    [organizationId, pathname, router]
  );

  const openWorktreeFromSidebar = useCallback(
    (worktreeId: string, sessionIdsByRecency: readonly string[]) => {
      const sessionId = getLatestOpenChatSessionId(sessionIdsByRecency, closedSessionIds);
      if (sessionId) {
        selectSession(sessionId);
      } else {
        openWorktree(worktreeId);
      }
    },
    [closedSessionIds, openWorktree, selectSession]
  );

  // Arriving at a chat's address from elsewhere (a link, history) reopens its
  // tab. A shown chat that is closed, by another window or while this window
  // was still navigating to it, is left instead, so it cannot come back later.
  useEffect(() => {
    const shownSessionId = currentSessionId ?? null;
    const addressed = addressedSessionRef.current;
    if (addressed === null || addressed.sessionId !== shownSessionId) {
      addressedSessionRef.current = { sessionId: shownSessionId };
      const arrival = arriveAtChatAddress(pendingNavigationRef.current, shownSessionId);
      pendingNavigationRef.current = arrival.pending;
      const restored = addressed === null && consumeRestoredDocumentNavigation();
      if (shownSessionId && !arrival.requestedHere && !restored) {
        openChatTab(shownSessionId);
        return;
      }
    }
    if (
      !shownSessionId ||
      !selectedWorktreeId ||
      getActiveChatSessionId(pendingNavigationRef.current, shownSessionId) !== shownSessionId ||
      !closedSessionIds.includes(shownSessionId) ||
      !worktreeChats.some(session => session.sessionId === shownSessionId)
    ) {
      return;
    }
    const nextSessionId = openWorktreeChats[0]?.sessionId;
    if (nextSessionId) {
      openSessionInternal(nextSessionId, { replace: true });
    } else {
      openWorktree(selectedWorktreeId, { replace: true });
    }
  }, [
    closedSessionIds,
    currentSessionId,
    openChatTab,
    openSessionInternal,
    openWorktree,
    openWorktreeChats,
    selectedWorktreeId,
    worktreeChats,
  ]);

  const closeSession = useCallback(
    (sessionId: string) => {
      if (!selectedWorktreeId || !worktreeChats.some(session => session.sessionId === sessionId)) {
        return;
      }
      closeChatTab(sessionId);
      // The tab may already be the target of a navigation the router has not shown yet.
      const activeSessionId = getActiveChatSessionId(
        pendingNavigationRef.current,
        currentSessionId ?? null
      );
      if (sessionId !== activeSessionId) return;

      // Replace, so going back does not land on, and reopen, the closed chat.
      const nextSessionId = getNextOpenChatSessionId(
        openWorktreeChats.map(session => session.sessionId),
        sessionId
      );
      if (nextSessionId) {
        openSessionInternal(nextSessionId, { replace: true });
      } else {
        openWorktree(selectedWorktreeId, { replace: true });
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
      if (!worktreeId || !serverSourceId) {
        toast.error('Cannot start a new chat yet', {
          description: 'Wait for this worktree to finish syncing, then try again.',
        });
        return false;
      }

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
      focusComposerForSession(kiloSessionId);
      openSessionInternal(kiloSessionId);
      return true;
    },
    [
      cachedSessions,
      createLocalSession,
      focusComposerForSession,
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

  const deletableSessionsById = useMemo(
    () =>
      new Map(
        [...sessions, ...cachedSessions, ...worktreeChats].map(session => [
          session.sessionId,
          session,
        ])
      ),
    [cachedSessions, sessions, worktreeChats]
  );

  const navigateAfterWorkspaceDeletion = useCallback(
    (worktreeId: string, deletedSessionIds: readonly string[]) => {
      forgetWorktreeTabs(worktreeId, deletedSessionIds);
      const redirect = getWorktreeDeletionRedirect(
        new URL(window.location.href),
        worktreeId,
        deletedSessionIds,
        organizationId
      );
      if (redirect) router.push(redirect);
      return redirect !== null;
    },
    [forgetWorktreeTabs, organizationId, router]
  );

  const handleDeletedSessions = useCallback(
    (event: SessionDeletionEvent) => {
      const deleted = new Set(event.deletedSessionIds);
      if (
        event.scope === 'workspace' &&
        event.worktreeId &&
        navigateAfterWorkspaceDeletion(event.worktreeId, event.deletedSessionIds)
      ) {
        return;
      }
      if (!currentSessionId || !deleted.has(currentSessionId)) return;

      const survivingWorktreeChat = openWorktreeChats.find(
        session => !deleted.has(session.sessionId)
      );
      if (survivingWorktreeChat) {
        openSessionInternal(survivingWorktreeChat.sessionId);
        return;
      }
      if (selectedWorktreeId && worktreeChats.some(session => !deleted.has(session.sessionId))) {
        openWorktree(selectedWorktreeId);
        return;
      }
      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      router.replace(basePath);
    },
    [
      currentSessionId,
      navigateAfterWorkspaceDeletion,
      openSessionInternal,
      openWorktree,
      openWorktreeChats,
      organizationId,
      router,
      selectedWorktreeId,
      worktreeChats,
    ]
  );

  const {
    deleteSession,
    deletingSessionIds: deletingSessionIdSet,
    deletingWorktreeIds: deletingSessionWorktreeIds,
    isDeleting: isSessionDeleting,
  } = useSessionDeletion({
    organizationId,
    onDeleted: handleDeletedSessions,
  });
  const deletingSessionIds = useMemo(() => [...deletingSessionIdSet], [deletingSessionIdSet]);

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      const session = deletableSessionsById.get(sessionId);
      void deleteSession({
        sessionId,
        title: session?.prompt,
        worktreeId: session?.worktreeId ?? null,
      });
    },
    [deletableSessionsById, deleteSession]
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, title: string) => {
      await renameCliSessionV2({ session_id: sessionId, title });
      renameSessionLocally(sessionId, title);
      void queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeParent.pathFilter());
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
        queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeParent.pathFilter()),
        queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter()),
        queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter()),
      ]);
    },
    [organizationId, queryClient, renameWorktree, trpc]
  );

  const handleConfirmWorktreeDelete = useCallback(() => {
    const worktreeId = worktreePendingDeletion;
    if (
      !worktreeId ||
      deletingWorktreeIds.has(worktreeId) ||
      deletingSessionWorktreeIds.has(worktreeId)
    ) {
      return;
    }

    setWorktreePendingDeletion(undefined);
    setDeletingWorktreeIds(previous => new Set(previous).add(worktreeId));

    void (async () => {
      try {
        const { deletedSessionIds, cleanup } = await deleteWorktree({
          worktreeId: cloudAgentWorktreeIdSchema.parse(worktreeId),
          organizationId: organizationId ?? null,
        });
        await removeDeletedSessions({
          sessionIds: deletedSessionIds,
          queryClient,
          trpc,
          setDbSessions,
          deleteSessionFromStore,
        });
        navigateAfterWorkspaceDeletion(worktreeId, deletedSessionIds);
        await invalidateSessionQueries({ queryClient, trpc });
        if (cleanup === 'pending') {
          toast.warning('Workspace removed; runtime cleanup is incomplete.');
        } else {
          toast.success('Worktree deleted');
        }
      } catch (error) {
        toast.error('Could not delete the workspace', {
          description: getDeletionErrorMessage(error),
        });
        await invalidateSessionQueries({ queryClient, trpc });
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
    deletingSessionWorktreeIds,
    deletingWorktreeIds,
    navigateAfterWorkspaceDeletion,
    organizationId,
    queryClient,
    setDbSessions,
    trpc,
    worktreePendingDeletion,
  ]);

  const deletingWorktreeIdList = useMemo(
    () => [...new Set([...deletingWorktreeIds, ...deletingSessionWorktreeIds])],
    [deletingSessionWorktreeIds, deletingWorktreeIds]
  );
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
              onOpenWorktree={openWorktreeFromSidebar}
              organizationId={organizationId}
              onDeleteSession={handleDeleteSession}
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
              isDeletionInProgress={isSessionDeleting}
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
        <div
          className="relative hidden max-w-[max(20rem,calc(100%_-_28rem))] w-(--sessions-sidebar-width) shrink-0 border-r lg:block"
          style={{ '--sessions-sidebar-width': `${sessionsSidebarWidth}px` } as CSSProperties}
        >
          <ChatSidebar
            key={`desktop:${currentUserId}:${organizationId ?? 'personal'}`}
            workspaceFolders={sidebarWorkspaceFolders}
            sessions={sidebarSessions}
            currentSessionId={currentSessionId}
            selectedWorktreeId={selectedWorktreeId}
            onOpenSession={selectSession}
            onOpenWorktree={openWorktreeFromSidebar}
            organizationId={organizationId}
            onDeleteSession={handleDeleteSession}
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
            isDeletionInProgress={isSessionDeleting}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            platformFilter={platformFilter}
            onPlatformChange={setPlatformFilter}
            projectFilter={projectFilter}
            onProjectChange={setProjectFilter}
            recentProjects={recentProjects}
          />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sessions sidebar"
            aria-valuemin={SESSIONS_SIDEBAR_MIN_WIDTH}
            aria-valuemax={SESSIONS_SIDEBAR_MAX_WIDTH}
            aria-valuenow={sessionsSidebarWidth}
            aria-valuetext={`Preferred width ${sessionsSidebarWidth} pixels`}
            tabIndex={0}
            className="before:bg-border hover:before:bg-ring focus-visible:before:bg-ring absolute inset-y-0 -right-1.5 z-10 w-3 cursor-col-resize before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onMouseDown={startSessionsSidebarDrag}
            onKeyDown={handleSessionsSidebarKeyDown}
          />
        </div>

        {/* Main Content */}
        <div className="h-full min-w-0 flex-1 overflow-hidden">{children}</div>
      </div>
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
              and cleans up its sandbox resources. Other worktrees are not affected.
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
