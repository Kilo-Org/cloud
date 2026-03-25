'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useSetAtom } from 'jotai';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { extractRepoFromGitUrl } from './utils/git-utils';
import { ChatSidebar } from './ChatSidebar';
import { useSidebarSessions } from './hooks/useSidebarSessions';
import { useActiveSessions } from './hooks/useActiveSessions';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { deleteSessionFromStoreAtom } from './store/db-session-atoms';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

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
  const [platformFilter, setPlatformFilter] = useState<string | undefined>('cloud-agent');
  const [projectFilter, setProjectFilter] = useState<string | undefined>(undefined);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const { sessions, refetchSessions, renameSessionLocally } = useSidebarSessions({
    organizationId: organizationId ?? null,
    searchQuery,
    createdOnPlatform:
      platformFilter === 'cloud-agent' ? ['cloud-agent', 'cloud-agent-web'] : platformFilter,
    gitUrl: projectFilter,
  });
  const { activeSessions } = useActiveSessions();

  // Session deletion (lightweight - no stream cleanup, container handles that on unmount)
  const trpc = useTRPC();

  const { data: recentReposData } = useQuery({
    ...trpc.unifiedSessions.recentRepositories.queryOptions({
      organizationId,
      recentDays: 30,
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

      void queryClient.invalidateQueries(trpc.unifiedSessions.list.pathFilter());
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
      void queryClient.invalidateQueries(trpc.unifiedSessions.list.pathFilter());
      void queryClient.invalidateQueries(trpc.unifiedSessions.search.pathFilter());
      refetchSessions();
    },
    [renameCliSessionV2, renameSessionLocally, queryClient, trpc, refetchSessions]
  );

  return (
    <SidebarLayoutContext.Provider
      value={{ toggleMobileSidebar: () => setMobileSheetOpen(prev => !prev) }}
    >
      <div className="flex h-dvh w-full overflow-hidden">
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
        <div className="flex-1 overflow-hidden">{children}</div>
      </div>
    </SidebarLayoutContext.Provider>
  );
}
