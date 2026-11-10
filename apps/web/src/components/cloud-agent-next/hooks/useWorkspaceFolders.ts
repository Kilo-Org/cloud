'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import type {
  WorkspaceFolderColor,
  WorkspaceFolderSortMode,
} from '@/lib/cloud-agent/workspace-folders';
import {
  controlPlaneSessionIdSchema,
  getInitializedSmartDoneFoldersStorageKey,
} from '../workspace-folders';
import { positionBetween } from '@/lib/todos/position';
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

  useEffect(() => {
    const doneFolders =
      foldersQuery.data?.folders.filter(
        folder => folder.kind === 'smart' && folder.smartPreset === 'done'
      ) ?? [];
    if (doneFolders.length === 0 || typeof window === 'undefined') return;

    const storageKey = getInitializedSmartDoneFoldersStorageKey(currentUserId, organizationId);
    let initialized: string[] = [];
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]');
      if (Array.isArray(parsed)) {
        initialized = parsed.filter((value): value is string => typeof value === 'string');
      }
    } catch {
      initialized = [];
    }
    const unseen = doneFolders.filter(folder => !initialized.includes(folder.id));
    if (unseen.length === 0) return;

    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify([...initialized, ...unseen.map(folder => folder.id)])
      );
    } catch {
      // A full or blocked storage still collapses the folders for this mount.
    }
    setCollapsedFolderIds(ids => [...new Set([...ids, ...unseen.map(folder => folder.id)])]);
  }, [currentUserId, foldersQuery.data?.folders, organizationId, setCollapsedFolderIds]);

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries(trpc.cliSessionsV2.listWorkspaces.pathFilter()),
      queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter()),
    ]);
  }, [queryClient, queryKey, trpc]);

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

  const setFolderSortMode = useCallback(
    (folderId: string, sortMode: WorkspaceFolderSortMode) =>
      run(
        () => updateFolder({ folderId, sortMode, organizationId: organizationId ?? null }),
        'Folder order updated'
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
    async (worktreeId: string, folderId: string | null, position?: string | null) => {
      const moved = await run(
        () =>
          assignWorktree({
            worktreeId: cloudAgentWorktreeIdSchema.parse(worktreeId),
            folderId,
            organizationId: organizationId ?? null,
            ...(position === undefined ? {} : { position }),
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

  /**
   * Manual order treats every unpositioned row as before every positioned row.
   * A drag inside such a container therefore has to initialize all of its rows;
   * writing only the dragged row cannot place it among its unpositioned peers.
   * This runs only on an explicit drag/reorder action, once per container.
   */
  const initializeWorktreePositions = useCallback(
    async (orderedWorktreeIds: readonly string[], folderId: string | null): Promise<boolean> => {
      if (savingRef.current || orderedWorktreeIds.length > 200) return false;
      savingRef.current = true;
      setIsSaving(true);
      try {
        const positions: string[] = [];
        let previous: string | null = null;
        for (let index = 0; index < orderedWorktreeIds.length; index++) {
          const position = positionBetween(previous, null);
          positions.push(position);
          previous = position;
        }
        await Promise.all(
          orderedWorktreeIds.map((worktreeId, index) =>
            assignWorktree({
              worktreeId: cloudAgentWorktreeIdSchema.parse(worktreeId),
              folderId,
              organizationId: organizationId ?? null,
              position: positions[index],
            })
          )
        );
        await refresh();
        toast.success('Workspace order saved');
        return true;
      } catch {
        await refresh();
        toast.error('Could not save workspace order. Please try again.');
        return false;
      } finally {
        savingRef.current = false;
        setIsSaving(false);
      }
    },
    [assignWorktree, organizationId, refresh]
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
    setFolderSortMode,
    deleteFolder,
    moveWorktree,
    moveSession,
    initializeWorktreePositions,
    reorderFolders,
    refresh,
  };
}

export type WorkspaceFolderController = ReturnType<typeof useWorkspaceFolders>;
