import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { toast } from 'sonner-native';

import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import {
  mapStoredSessions,
  removeStoredSession,
  type SessionsListData,
} from '@/lib/session-list-cache';
import { useTRPC } from '@/lib/trpc';

type SessionsListSnapshot = [QueryKey, SessionsListData | undefined][];

const onError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

export function useSessionMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // ponytail: a ref (not state) is enough — this only gates duplicate taps
  // on the same row, it never needs to drive a re-render.
  const pendingSessionIds = useRef(new Set<string>());
  const listKey = trpc.cliSessionsV2.list.infiniteQueryKey();

  const invalidateSessions = async () => {
    await invalidateAgentSessionQueries(queryClient, trpc);
  };

  const snapshotAndUpdate = async (update: (data: SessionsListData) => SessionsListData) => {
    await queryClient.cancelQueries({ queryKey: listKey });
    const previous = queryClient.getQueriesData<SessionsListData>({ queryKey: listKey });
    queryClient.setQueriesData<SessionsListData>({ queryKey: listKey }, old =>
      old ? update(old) : old
    );
    return { previous };
  };

  const rollback = (previous?: SessionsListSnapshot) => {
    for (const [key, data] of previous ?? []) {
      queryClient.setQueryData(key, data);
    }
  };

  const deleteSessionMutation = useMutation(
    trpc.cliSessionsV2.delete.mutationOptions({
      onMutate: async ({ session_id }) => {
        const context = await snapshotAndUpdate(data => removeStoredSession(data, session_id));
        return context;
      },
      onError: (error, _input, context) => {
        rollback(context?.previous);
        onError(error);
      },
      onSettled: invalidateSessions,
    })
  );

  const renameSessionMutation = useMutation(
    trpc.cliSessionsV2.rename.mutationOptions({
      onMutate: async ({ session_id, title }) => {
        const context = await snapshotAndUpdate(data =>
          mapStoredSessions(data, session_id, session => ({ ...session, title }))
        );
        return context;
      },
      onError: (error, _input, context) => {
        rollback(context?.previous);
        onError(error);
      },
      onSettled: invalidateSessions,
    })
  );

  // Optimistic updates already make the row change land instantly, so a
  // second tap before the first mutation settles would just be a duplicate
  // in-flight request for the same row — drop it instead of firing another.
  const withPendingGuard = (sessionId: string, run: () => Promise<unknown>) => {
    if (pendingSessionIds.current.has(sessionId)) {
      return;
    }
    pendingSessionIds.current.add(sessionId);
    void (async () => {
      try {
        await run();
      } catch {
        // Already surfaced via the mutation's own onError (toast + rollback).
      } finally {
        pendingSessionIds.current.delete(sessionId);
      }
    })();
  };

  return {
    deleteSession: (sessionId: string) => {
      withPendingGuard(sessionId, async () => {
        const result = await deleteSessionMutation.mutateAsync({ session_id: sessionId });
        return result;
      });
    },
    renameSession: (sessionId: string, title: string) => {
      withPendingGuard(sessionId, async () => {
        const result = await renameSessionMutation.mutateAsync({ session_id: sessionId, title });
        return result;
      });
    },
  };
}
