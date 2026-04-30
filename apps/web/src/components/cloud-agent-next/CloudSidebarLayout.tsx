'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useSetAtom } from 'jotai';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { startOfDay, subDays } from 'date-fns';
import { extractRepoFromGitUrl } from './utils/git-utils';
import { ChatSidebar } from './ChatSidebar';
import { useSidebarSessions } from './hooks/useSidebarSessions';
import { useActiveSessions } from './hooks/useActiveSessions';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { deleteSessionFromStoreAtom } from './store/db-session-atoms';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
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

  const { sessions, refetchSessions, renameSessionLocally } = useSidebarSessions({
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

  const { mutateAsync: deleteCliSession } = useMutation(trpc.cliSessions.delete.mutationOptions());
  const { mutateAsync: deleteCliSessionV2 } = useMutation(
    trpc.cliSessionsV2.delete.mutationOptions()
  );
  const { mutateAsync: renameCliSessionV2 } = useMutation(
    trpc.cliSessionsV2.rename.mutationOptions()
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      // Navigate away if deleting the current session
      if (sessionId === currentSessionId) {
        const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
        router.push(basePath);
      }

      // Delete from IndexedDB (optimistic)
      try {
        await deleteSessionFromStore(sessionId);
      } catch (error) {
        console.error('Error deleting session from IndexedDB:', error);
      }

      // Delete from server
      try {
        if (isNewSession(sessionId)) {
          await deleteCliSessionV2({ session_id: sessionId });
        } else {
          await deleteCliSession({ session_id: sessionId });
        }
        toast('Session deleted successfully');
      } catch (error) {
        console.error('Error calling session deletion API:', error);
        toast.error('Failed to delete session');
      }

      void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
      refetchSessions();
    },
    [
      currentSessionId,
      organizationId,
      router,
      deleteSessionFromStore,
      deleteCliSession,
      deleteCliSessionV2,
      queryClient,
      trpc,
      refetchSessions,
    ]
  );

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
              sessions={sessions}
              currentSessionId={currentSessionId}
              organizationId={organizationId}
              onDeleteSession={handleDeleteSession}
              onRenameSession={handleRenameSession}
              isInSheet
              activeSessions={activeSessions}
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
            sessions={sessions}
            currentSessionId={currentSessionId}
            organizationId={organizationId}
            onDeleteSession={handleDeleteSession}
            onRenameSession={handleRenameSession}
            activeSessions={activeSessions}
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
    </SidebarLayoutContext.Provider>
  );
}
