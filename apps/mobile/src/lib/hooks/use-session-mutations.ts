import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { chainSave } from '@/lib/hooks/save-chain';
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
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onMutate: ({ session_id }) =>
        snapshotAndUpdate(data => removeStoredSession(data, session_id)),
      onError: (error, _input, context) => {
        rollback(context?.previous);
        onError(error);
      },
      onSettled: invalidateSessions,
    })
  );

  const renameSessionMutation = useMutation(
    trpc.cliSessionsV2.rename.mutationOptions({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onMutate: ({ session_id, title }) =>
        snapshotAndUpdate(data =>
          mapStoredSessions(data, session_id, session => ({ ...session, title }))
        ),
      onError: (error, _input, context) => {
        rollback(context?.previous);
        onError(error);
      },
      onSettled: invalidateSessions,
    })
  );

  // Per session row: DISTINCT operations (a delete during a settling rename,
  // a re-rename to a different title) run serialized through a per-session
  // chain (chainSave, see save-chain.ts) so their optimistic
  // snapshots/rollbacks can't interleave and an older request can never
  // overwrite a newer one's result. Rename goes through a modal confirm and
  // delete through Alert.alert, so an adjacent double-fire of the same op
  // is already impossible — no dedupe needed here.
  //
  // `renameSession` is the list's fire-and-forget caller. Detail callers
  // (e.g. the session detail header) use `renameSessionAsync`, which awaits
  // the same mutation + chain so a rejection surfaces the existing toast,
  // rolls back the list cache, and lets the caller keep its modal open for
  // retry.
  return {
    deleteSession: (sessionId: string) => {
      void (async () => {
        try {
          // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
          await chainSave(sessionId, () =>
            deleteSessionMutation.mutateAsync({ session_id: sessionId })
          );
        } catch {
          // Already surfaced via the mutation's own onError (toast + rollback).
        }
      })();
    },
    renameSession: (sessionId: string, title: string) => {
      void (async () => {
        try {
          // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
          await chainSave(sessionId, () =>
            renameSessionMutation.mutateAsync({ session_id: sessionId, title })
          );
        } catch {
          // Already surfaced via the mutation's own onError (toast + rollback).
        }
      })();
    },
    renameSessionAsync: async (sessionId: string, title: string) => {
      // The mutation's onError toasts and rolls back the list cache before
      // this rejection propagates, so callers can rethrow to keep their
      // modal open without duplicating user-visible error handling.
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      await chainSave(sessionId, () =>
        renameSessionMutation.mutateAsync({ session_id: sessionId, title })
      );
    },
  };
}
