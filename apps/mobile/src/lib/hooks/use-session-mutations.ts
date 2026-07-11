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
  // Refs (not state) are enough — these only gate duplicate taps and order
  // mutations per row, they never need to drive a re-render.
  const pendingSessionIds = useRef(new Set<string>());
  const sessionOpChains = useRef(new Map<string, Promise<unknown>>());
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

  // Two rules per session row:
  // - identical duplicate taps (same op + args) are dropped while pending —
  //   optimistic updates make the first tap land instantly, a second is noise;
  // - DISTINCT operations (a delete during a settling rename, a re-rename to
  //   a different title) run, but serialized through a per-session promise
  //   chain so their optimistic snapshots/rollbacks can't interleave and an
  //   older request can never overwrite a newer one's result.
  const enqueueSessionOp = (sessionId: string, opKey: string, run: () => Promise<unknown>) => {
    if (pendingSessionIds.current.has(opKey)) {
      return;
    }
    pendingSessionIds.current.add(opKey);
    const previous = sessionOpChains.current.get(sessionId);
    let next: Promise<void> | undefined = undefined;
    next = (async () => {
      try {
        await previous;
      } catch {
        // The prior op already reported via its mutation's onError.
      }
      try {
        await run();
      } catch {
        // Already surfaced via the mutation's own onError (toast + rollback).
      }
      pendingSessionIds.current.delete(opKey);
      if (sessionOpChains.current.get(sessionId) === next) {
        sessionOpChains.current.delete(sessionId);
      }
    })();
    sessionOpChains.current.set(sessionId, next);
  };

  return {
    deleteSession: (sessionId: string) => {
      enqueueSessionOp(sessionId, `delete:${sessionId}`, async () => {
        await deleteSessionMutation.mutateAsync({ session_id: sessionId });
      });
    },
    renameSession: (sessionId: string, title: string) => {
      enqueueSessionOp(sessionId, `rename:${sessionId}:${title}`, async () => {
        await renameSessionMutation.mutateAsync({ session_id: sessionId, title });
      });
    },
  };
}
