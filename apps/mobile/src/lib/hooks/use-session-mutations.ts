import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';

import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { applyActiveSessionTitle, type CachedActiveSessionsData } from '@/lib/active-sessions-live';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { chainSave } from '@/lib/hooks/save-chain';
import {
  mapStoredSessions,
  removeStoredSession,
  type SessionsListData,
} from '@/lib/session-list-cache';
import { useTRPC } from '@/lib/trpc';

type SessionsListSnapshot = [QueryKey, SessionsListData | undefined][];

const onError = (error: { message: string }) => {
  announcingToast.error(error.message || 'Something went wrong');
};

export function useSessionMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listKey = trpc.cliSessionsV2.list.infiniteQueryKey();
  const activeListFilter = trpc.activeSessions.list.pathFilter();

  const invalidateSessions = async () => {
    await invalidateAgentSessionQueries(queryClient, trpc);
  };

  const snapshotAndUpdate = async (
    update: (data: SessionsListData) => SessionsListData
  ): Promise<{ previous: SessionsListSnapshot }> => {
    await queryClient.cancelQueries({ queryKey: listKey });
    const previous = queryClient.getQueriesData<SessionsListData>({ queryKey: listKey });
    queryClient.setQueriesData<SessionsListData>({ queryKey: listKey }, old =>
      old ? update(old) : old
    );
    return { previous };
  };

  /**
   * Optimistically retitle the row in every cached "Active now" tray. The tray
   * cache is keyed per personal/org context, so patch them all by path filter —
   * the mutation hook has no context of its own, and a rename is rare.
   */
  const snapshotAndUpdateActive = async (sessionId: string, title: string) => {
    await queryClient.cancelQueries(activeListFilter);
    const previousActive = queryClient.getQueriesData<CachedActiveSessionsData>(activeListFilter);
    queryClient.setQueriesData<CachedActiveSessionsData>(activeListFilter, old =>
      old ? { sessions: applyActiveSessionTitle(old.sessions, sessionId, title) } : old
    );
    return previousActive;
  };

  const rollback = (previous?: [QueryKey, unknown][]) => {
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
      onMutate: async ({ session_id, title }) => {
        const { previous } = await snapshotAndUpdate(data =>
          mapStoredSessions(data, session_id, session => ({ ...session, title }))
        );
        const previousActive = await snapshotAndUpdateActive(session_id, title);
        return { previous, previousActive };
      },
      onError: (error, _input, context) => {
        rollback(context?.previous);
        rollback(context?.previousActive);
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
    // `onDeleted` runs only after the server confirms the delete (the
    // optimistic removal already happened in onMutate). It lets the list
    // move assistive-technology focus to a stable anchor; it is NOT invoked
    // on failure, so a failed delete never moves focus. The success toast
    // lives here (the hook owns outcome toasts) and announces the deletion
    // through the shared announcingToast owner.
    deleteSession: (sessionId: string, onDeleted?: () => void) => {
      void (async () => {
        try {
          // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
          await chainSave(sessionId, () =>
            deleteSessionMutation.mutateAsync({ session_id: sessionId })
          );
          announcingToast.success('Session deleted');
          onDeleted?.();
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
