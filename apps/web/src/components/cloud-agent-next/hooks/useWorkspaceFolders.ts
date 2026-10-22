'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import type { WorkspaceFolderColor } from '@/lib/cloud-agent/workspace-folders';
import { controlPlaneSessionIdSchema } from '../workspace-folders';
import { workspaceFoldersQueryKey } from './sidebar-queries';
import type { useSidebarPreferences } from './useSidebarPreferences';

type CollapsedFolders = Pick<
  ReturnType<typeof useSidebarPreferences>,
  'collapsedFolderIds' | 'setCollapsedFolderIds'
>;

export function useWorkspaceFolders(
  currentUserId: string,
  organizationId: string | undefined,
  { collapsedFolderIds, setCollapsedFolderIds }: CollapsedFolders
) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryOptions = useMemo(
    () => trpc.workspaceFolders.list.queryOptions({ organizationId: organizationId ?? null }),
    [organizationId, trpc]
  );
  const queryKey = useMemo(
    () => workspaceFoldersQueryKey(queryOptions.queryKey, currentUserId),
    [currentUserId, queryOptions.queryKey]
  );
  const foldersQuery = useQuery({ ...queryOptions, queryKey, staleTime: 15_000 });
  const { mutateAsync: createFolder } = useMutation(trpc.workspaceFolders.create.mutationOptions());
  const { mutateAsync: updateFolder } = useMutation(trpc.workspaceFolders.update.mutationOptions());
  const { mutateAsync: removeFolder } = useMutation(trpc.workspaceFolders.delete.mutationOptions());
  const { mutateAsync: assignWorktree } = useMutation(
    trpc.workspaceFolders.moveWorktree.mutationOptions()
  );
  const { mutateAsync: assignSession } = useMutation(
    trpc.workspaceFolders.moveSession.mutationOptions()
  );
  const { mutateAsync: reorder } = useMutation(trpc.workspaceFolders.reorder.mutationOptions());
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey]
  );

  const run = useCallback(
    async (mutation: () => Promise<unknown>, successMessage: string): Promise<boolean> => {
      if (savingRef.current) return false;
      savingRef.current = true;
      setIsSaving(true);
      try {
        await mutation();
        await refresh();
        toast.success(successMessage);
        return true;
      } catch {
        await refresh();
        toast.error('Could not save folders. Please try again.');
        return false;
      } finally {
        savingRef.current = false;
        setIsSaving(false);
      }
    },
    [refresh]
  );

  const saveFolder = useCallback(
    (folderId: string | null, values: { name: string; color: WorkspaceFolderColor }) =>
      run(
        () =>
          folderId
            ? updateFolder({ ...values, organizationId: organizationId ?? null, folderId })
            : createFolder({ ...values, organizationId: organizationId ?? null }),
        folderId ? 'Folder updated' : 'Folder created'
      ),
    [createFolder, organizationId, run, updateFolder]
  );

  const setFolderColor = useCallback(
    (folderId: string, color: WorkspaceFolderColor) =>
      run(
        () => updateFolder({ folderId, color, organizationId: organizationId ?? null }),
        'Folder color updated'
      ),
    [organizationId, run, updateFolder]
  );

  const deleteFolder = useCallback(
    (folderId: string) =>
      run(
        () => removeFolder({ folderId, organizationId: organizationId ?? null }),
        'Folder deleted. Workspaces moved to Ungrouped.'
      ),
    [organizationId, removeFolder, run]
  );

  const moveWorktree = useCallback(
    async (worktreeId: string, folderId: string | null) => {
      const moved = await run(
        () =>
          assignWorktree({
            worktreeId: cloudAgentWorktreeIdSchema.parse(worktreeId),
            folderId,
            organizationId: organizationId ?? null,
          }),
        folderId ? 'Workspace moved to folder' : 'Workspace moved to Ungrouped'
      );
      if (moved && folderId) setCollapsedFolderIds(ids => ids.filter(id => id !== folderId));
      return moved;
    },
    [assignWorktree, organizationId, run, setCollapsedFolderIds]
  );

  const moveSession = useCallback(
    async (sessionId: string, folderId: string | null) => {
      const moved = await run(
        () =>
          assignSession({
            sessionId: controlPlaneSessionIdSchema.parse(sessionId),
            folderId,
            organizationId: organizationId ?? null,
          }),
        folderId ? 'Session moved to folder' : 'Session moved to Ungrouped'
      );
      if (moved) {
        // The destination folder changes how the sidebar groups the session,
        // so the sessions and worktree-details queries must refetch too.
        void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
        void queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter());
        void queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter());
        if (folderId) setCollapsedFolderIds(ids => ids.filter(id => id !== folderId));
      }
      return moved;
    },
    [assignSession, organizationId, queryClient, run, setCollapsedFolderIds, trpc]
  );

  const reorderFolders = useCallback(
    (folderIds: string[]) =>
      run(
        () => reorder({ folderIds, organizationId: organizationId ?? null }),
        'Folder order updated'
      ),
    [organizationId, reorder, run]
  );

  const toggleFolder = useCallback(
    (folderId: string) =>
      setCollapsedFolderIds(ids =>
        ids.includes(folderId) ? ids.filter(id => id !== folderId) : [...ids, folderId]
      ),
    [setCollapsedFolderIds]
  );

  return {
    folders: foldersQuery.data?.folders ?? [],
    isLoading: foldersQuery.isPending,
    /** Only the first request; a retry after a failure must not keep the list hidden. */
    isFirstLoadPending: foldersQuery.isPending && foldersQuery.failureCount === 0,
    isError: foldersQuery.isError,
    isSaving,
    collapsedFolderIds,
    toggleFolder,
    saveFolder,
    setFolderColor,
    deleteFolder,
    moveWorktree,
    moveSession,
    reorderFolders,
    refresh,
  };
}

export type WorkspaceFolderController = ReturnType<typeof useWorkspaceFolders>;
