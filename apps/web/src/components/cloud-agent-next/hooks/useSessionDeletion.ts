'use client';

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSetAtom } from 'jotai';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { useConfirm } from '@/components/ui/confirm';
import { dbSessionsAtom, deleteSessionFromStoreAtom } from '../store/db-session-atoms';
import {
  createSessionDeletionFlow,
  invalidateSessionQueries,
  removeDeletedSessions,
  type SessionDeletionEvent,
  type SessionDeletionFlow,
  type SessionDeletionTarget,
} from '../session-deletion';

type UseSessionDeletionOptions = {
  organizationId?: string;
  onDeleted?: (event: SessionDeletionEvent) => void;
};

export function useSessionDeletion({ organizationId, onDeleted }: UseSessionDeletionOptions = {}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const setDbSessions = useSetAtom(dbSessionsAtom);
  const deleteSessionFromStore = useSetAtom(deleteSessionFromStoreAtom);
  const { mutateAsync: deleteSessionMutation } = useMutation(
    trpc.cliSessionsV2.delete.mutationOptions()
  );
  const { mutateAsync: deleteWorktreeMutation } = useMutation(
    trpc.cliSessionsV2.deleteWorktree.mutationOptions()
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletingSessionIds, setDeletingSessionIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [deletingWorktreeIds, setDeletingWorktreeIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const flowRef = useRef<SessionDeletionFlow | null>(null);
  if (!flowRef.current) flowRef.current = createSessionDeletionFlow();
  const operationKeys = useRef(new Map<string, string>());
  const onDeletedRef = useRef(onDeleted);
  onDeletedRef.current = onDeleted;

  const setSessionPending = useCallback((sessionId: string, pending: boolean) => {
    setDeletingSessionIds(previous => {
      const next = new Set(previous);
      if (pending) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);

  const setWorktreePending = useCallback((worktreeId: string, pending: boolean) => {
    setDeletingWorktreeIds(previous => {
      const next = new Set(previous);
      if (pending) next.add(worktreeId);
      else next.delete(worktreeId);
      return next;
    });
  }, []);

  const getOperationKey = useCallback((sessionId: string) => {
    const existing = operationKeys.current.get(sessionId);
    if (existing) return existing;
    const operationKey = crypto.randomUUID();
    operationKeys.current.set(sessionId, operationKey);
    return operationKey;
  }, []);

  const dropOperationKey = useCallback((sessionId: string) => {
    operationKeys.current.delete(sessionId);
  }, []);

  const deleteSession = useCallback(
    async (target: SessionDeletionTarget) => {
      const flow = flowRef.current;
      if (!flow || flow.isActive()) return false;
      setIsDeleting(true);
      try {
        return await flow.deleteSession(target, {
          organizationId,
          confirm,
          deleteSession: input => deleteSessionMutation(input),
          deleteWorktree: input => deleteWorktreeMutation(input),
          removeDeletedSessions: sessionIds =>
            removeDeletedSessions({
              sessionIds,
              queryClient,
              trpc,
              setDbSessions,
              deleteSessionFromStore,
            }),
          invalidateQueries: () => invalidateSessionQueries({ queryClient, trpc }),
          notifyDeleted: event => onDeletedRef.current?.(event),
          setSessionPending,
          setWorktreePending,
          getOperationKey,
          dropOperationKey,
          notifySuccess: message => toast.success(message),
          notifyWarning: message => toast.warning(message),
          notifyError: (title, description) => toast.error(title, { description }),
        });
      } finally {
        setIsDeleting(false);
      }
    },
    [
      confirm,
      deleteSessionMutation,
      deleteSessionFromStore,
      deleteWorktreeMutation,
      dropOperationKey,
      getOperationKey,
      organizationId,
      queryClient,
      setDbSessions,
      setSessionPending,
      setWorktreePending,
      trpc,
    ]
  );

  return { deleteSession, deletingSessionIds, deletingWorktreeIds, isDeleting };
}
