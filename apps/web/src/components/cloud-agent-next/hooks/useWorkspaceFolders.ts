'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TRPCQueryKey } from '@trpc/tanstack-react-query';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import type { WorkspaceFolderColor } from '@/lib/cloud-agent/workspace-folders';
import {
  getCollapsedWorkspaceFoldersStorageKey,
  parseCollapsedWorkspaceFolders,
} from '../workspace-folders';

export function useWorkspaceFolders(currentUserId: string, organizationId?: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryOptions = useMemo(
    () => trpc.workspaceFolders.list.queryOptions({ organizationId: organizationId ?? null }),
    [organizationId, trpc]
  );
  const queryKey = useMemo<TRPCQueryKey>(() => {
    const options = { ...queryOptions.queryKey[1], userId: currentUserId };
    return [queryOptions.queryKey[0], options];
  }, [currentUserId, queryOptions.queryKey]);
  const foldersQuery = useQuery({ ...queryOptions, queryKey, staleTime: 15_000 });
  const { mutateAsync: createFolder } = useMutation(trpc.workspaceFolders.create.mutationOptions());
  const { mutateAsync: updateFolder } = useMutation(trpc.workspaceFolders.update.mutationOptions());
  const { mutateAsync: removeFolder } = useMutation(trpc.workspaceFolders.delete.mutationOptions());
  const { mutateAsync: assignWorktree } = useMutation(
    trpc.workspaceFolders.moveWorktree.mutationOptions()
  );
  const { mutateAsync: reorder } = useMutation(trpc.workspaceFolders.reorder.mutationOptions());
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const [collapsedFolderIds, setCollapsedFolderIds] = useLocalStorage<string[]>(
    getCollapsedWorkspaceFoldersStorageKey(currentUserId, organizationId),
    [],
    { initializeWithValue: false, deserializer: parseCollapsedWorkspaceFolders }
  );

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
    isError: foldersQuery.isError,
    isSaving,
    collapsedFolderIds,
    toggleFolder,
    saveFolder,
    setFolderColor,
    deleteFolder,
    moveWorktree,
    reorderFolders,
    refresh,
  };
}

export type WorkspaceFolderController = ReturnType<typeof useWorkspaceFolders>;
