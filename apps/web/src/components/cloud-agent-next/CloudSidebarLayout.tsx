'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient, useMutation, useMutationState } from '@tanstack/react-query';
import { useSetAtom } from 'jotai';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { startOfDay, subDays } from 'date-fns';
import { extractRepoFromGitUrl } from './utils/git-utils';
import { ChatSidebar } from './ChatSidebar';
import { useSidebarSessions } from './hooks/useSidebarSessions';
import { useActiveSessions } from './hooks/useActiveSessions';
import { deleteSessionFromStoreAtom } from './store/db-session-atoms';
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

// Context for children to toggle the mobile sidebar sheet
type SidebarLayoutContextValue = {
  toggleMobileSidebar: () => void;
};

const SidebarLayoutContext = createContext<SidebarLayoutContextValue>({
  toggleMobileSidebar: () => {},
});

export function useSidebarToggle() {
  return useContext(SidebarLayoutContext);
}

type CloudSidebarLayoutProps = {
  organizationId?: string;
  children: ReactNode;
};

export function CloudSidebarLayout({ organizationId, children }: CloudSidebarLayoutProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentSessionId = searchParams.get('sessionId') ?? undefined;

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

  const { sessions, refetchSessions, removeSessionLocally, renameSessionLocally } =
    useSidebarSessions({
      organizationId: organizationId ?? null,
      searchQuery,
      createdOnPlatform,
      gitUrl: projectFilter.length > 0 ? projectFilter : undefined,
    });
  const { activeSessions } = useActiveSessions();

  // Session deletion (lightweight - no stream cleanup, container handles that on unmount)
  const trpc = useTRPC();

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
  const deleteSessionFromStore = useSetAtom(deleteSessionFromStoreAtom);

  const invalidateSessionQueries = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter()),
        queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter()),
        queryClient.invalidateQueries(trpc.cliSessionsV2.recentRepositories.pathFilter()),
        queryClient.invalidateQueries(trpc.activeSessions.list.pathFilter()),
      ]),
    [queryClient, trpc]
  );

  const { mutate: deleteCliSessionV2 } = useMutation(
    trpc.cliSessionsV2.delete.mutationOptions({
      onSuccess: async (_data, { session_id: sessionId }) => {
        await Promise.all([
          queryClient.cancelQueries(trpc.cliSessionsV2.list.pathFilter()),
          queryClient.cancelQueries(trpc.cliSessionsV2.search.pathFilter()),
          queryClient.cancelQueries(trpc.activeSessions.list.pathFilter()),
        ]);
        removeSessionLocally(sessionId);
        queryClient.setQueryData(
          trpc.activeSessions.list.queryKey(),
          current =>
            current && {
              ...current,
              sessions: current.sessions.filter(session => session.id !== sessionId),
            }
        );

        try {
          await deleteSessionFromStore(sessionId);
        } catch (error) {
          console.error('Error deleting session from IndexedDB:', error);
        }

        toast('Session deleted successfully');
        await invalidateSessionQueries();
      },
      onError: error => {
        console.error('Error calling session deletion API:', error);
        toast.error('Failed to delete session. Please try again.');
        void invalidateSessionQueries();
      },
    })
  );
  const deletingSessionIds = useMutationState({
    filters: { mutationKey: trpc.cliSessionsV2.delete.mutationKey(), status: 'pending' },
    select: mutation =>
      (mutation.state.variables as Parameters<typeof deleteCliSessionV2>[0]).session_id,
  });
  const visibleSessions = useMemo(
    () => sessions.filter(session => !deletingSessionIds.includes(session.sessionId)),
    [sessions, deletingSessionIds]
  );
  const visibleActiveSessions = useMemo(
    () => activeSessions.filter(session => !deletingSessionIds.includes(session.id)),
    [activeSessions, deletingSessionIds]
  );

  const { mutateAsync: renameCliSessionV2 } = useMutation(
    trpc.cliSessionsV2.rename.mutationOptions()
  );

  const handleConfirmDelete = useCallback(() => {
    if (!sessionPendingDeletion || deletingSessionIds.includes(sessionPendingDeletion)) return;

    setSessionPendingDeletion(undefined);
    deleteCliSessionV2({ session_id: sessionPendingDeletion });
    if (sessionPendingDeletion === currentSessionId) {
      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      router.replace(basePath);
    }
  }, [
    sessionPendingDeletion,
    deletingSessionIds,
    deleteCliSessionV2,
    currentSessionId,
    organizationId,
    router,
  ]);

  const handleRenameSession = useCallback(
    async (sessionId: string, title: string) => {
      await renameCliSessionV2({ session_id: sessionId, title });
      renameSessionLocally(sessionId, title);
      void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
      void queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter());
      refetchSessions();
    },
    [renameCliSessionV2, renameSessionLocally, queryClient, trpc, refetchSessions]
  );

  return (
    <SidebarLayoutContext.Provider
      value={{ toggleMobileSidebar: () => setMobileSheetOpen(prev => !prev) }}
    >
      <div className="flex h-[calc(100dvh-3.5rem)] w-full overflow-hidden">
        {/* Mobile Sheet */}
        <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
          <SheetContent side="left" className="w-80 p-0 lg:hidden">
            <SheetHeader className="sr-only">
              <SheetTitle>Sessions</SheetTitle>
            </SheetHeader>
            <ChatSidebar
              sessions={visibleSessions}
              currentSessionId={currentSessionId}
              organizationId={organizationId}
              onDeleteSession={setSessionPendingDeletion}
              onRenameSession={handleRenameSession}
              isInSheet
              activeSessions={visibleActiveSessions}
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
            sessions={visibleSessions}
            currentSessionId={currentSessionId}
            organizationId={organizationId}
            onDeleteSession={setSessionPendingDeletion}
            onRenameSession={handleRenameSession}
            activeSessions={visibleActiveSessions}
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
        <div className="h-full flex-1 overflow-hidden">{children}</div>
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
    </SidebarLayoutContext.Provider>
  );
}
