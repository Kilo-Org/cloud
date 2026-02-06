/**
 * useSessionDeletion hook
 *
 * Handles session deletion logic including:
 * - Cleaning up current session state if deleting active session
 * - Deleting from IndexedDB via Jotai atoms
 * - Calling the unified cliSessions.delete mutation
 * - Navigating away from deleted session
 */

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useSetAtom } from 'jotai';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { clearMessagesAtom, currentSessionIdAtom } from '../store/atoms';
import { deleteSessionFromStoreAtom } from '../store/db-session-atoms';

type UseSessionDeletionOptions = {
  organizationId?: string;
  /** The currently visible DB session ID (UUID format) from the URL/chat UI */
  currentDbSessionId: string | null;
  cleanup: () => void;
  refetchSessions: () => void;
};

type UseSessionDeletionReturn = {
  /**
   * Delete a session by its database session ID (UUID).
   */
  handleDeleteSession: (sessionId: string) => Promise<void>;
};

export function useSessionDeletion({
  organizationId,
  currentDbSessionId,
  cleanup,
  refetchSessions,
}: UseSessionDeletionOptions): UseSessionDeletionReturn {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Write to atoms
  const clearMessages = useSetAtom(clearMessagesAtom);
  const setCurrentSessionId = useSetAtom(currentSessionIdAtom);
  const deleteSessionFromStore = useSetAtom(deleteSessionFromStoreAtom);

  // Set up tRPC mutation for unified session deletion
  const { mutateAsync: deleteCliSession } = useMutation(trpc.cliSessions.delete.mutationOptions());

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      // If deleting the currently visible session, stop the stream first to prevent race conditions
      if (sessionId === currentDbSessionId) {
        cleanup();
        clearMessages();
        setCurrentSessionId(null);

        const basePath = organizationId
          ? `/organizations/${organizationId}/cloud-next`
          : '/cloud-next';
        router.push(basePath);
      }

      // Delete from IndexedDB first (optimistic, for immediate UI feedback)
      try {
        await deleteSessionFromStore(sessionId);
      } catch (error) {
        console.error('Error deleting session from IndexedDB:', error);
      }

      // Delete from server (source of truth)
      let serverDeleteFailed = false;
      try {
        await deleteCliSession({ session_id: sessionId });
      } catch (error) {
        console.error('Error calling session deletion API:', error);
        serverDeleteFailed = true;
      }

      void queryClient.invalidateQueries(trpc.cliSessions.list.pathFilter());

      // Always refetch sessions to sync with server state
      // If delete succeeded: session will be gone from the list
      // If delete failed: session will reappear in the list (self-healing)
      refetchSessions();

      // Show appropriate toast
      if (serverDeleteFailed) {
        toast.error('Failed to delete session');
      } else {
        toast('Session deleted successfully');
      }
    },
    [
      cleanup,
      currentDbSessionId,
      clearMessages,
      setCurrentSessionId,
      organizationId,
      router,
      deleteSessionFromStore,
      deleteCliSession,
      refetchSessions,
      queryClient,
      trpc,
    ]
  );

  return { handleDeleteSession };
}
