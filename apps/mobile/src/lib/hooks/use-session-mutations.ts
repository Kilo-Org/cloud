import { hashKey, type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { applyActiveSessionTitle, type CachedActiveSessionsData } from '@/lib/active-sessions-live';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { chainSave } from '@/lib/hooks/save-chain';
import { scheduleCacheMaintenance } from '@/lib/query/schedule-cache-maintenance';
import {
  mapStoredSessions,
  removeStoredSession,
  type SessionsListData,
} from '@/lib/session-list-cache';
import { useTRPC } from '@/lib/trpc';

type SessionsListSnapshot = [QueryKey, SessionsListData | undefined][];

// Keep the epoch beside the original variables, never in the mutation input.
// Weak keys survive a hook render without retaining completed operations.
const operationEpochs = new WeakMap<object, number>();

function isCurrentOperation(epoch: number | undefined): epoch is number {
  return epoch !== undefined && isCurrentAuthEpoch(epoch) && !isSignOutActive();
}

function assertCurrentOperation(epoch: number | undefined): asserts epoch is number {
  if (!isCurrentOperation(epoch)) {
    throw new Error('Session operation belongs to an inactive account');
  }
}

// Fence both outcomes before MutationCache can run global auth callbacks.
async function settleCurrentOperation<T>(epoch: number, operation: Promise<T>): Promise<T> {
  try {
    const result = await operation;
    assertCurrentOperation(epoch);
    return result;
  } catch (error) {
    assertCurrentOperation(epoch);
    throw error;
  }
}

const onError = (error: { message: string }) => {
  announcingToast.error(error.message || i18n.t('common.somethingWentWrong'));
};

export function useSessionMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listKey = trpc.cliSessionsV2.list.infiniteQueryKey();
  const activeListFilter = trpc.activeSessions.list.pathFilter();

  const invalidateSessions = (epoch: number | undefined) => {
    if (!isCurrentOperation(epoch)) {
      return;
    }
    scheduleCacheMaintenance(() => {
      if (isCurrentOperation(epoch)) {
        void invalidateAgentSessionQueries(queryClient, trpc);
      }
    });
  };

  const snapshotAndUpdate = async (
    update: (data: SessionsListData) => SessionsListData,
    epoch: number | undefined
  ): Promise<{ previous: SessionsListSnapshot; generation: number; epoch: number }> => {
    assertCurrentOperation(epoch);
    await queryClient.cancelQueries({ queryKey: listKey });
    assertCurrentOperation(epoch);
    const generation = nextMutationGeneration(hashKey(listKey));
    const previous = queryClient.getQueriesData<SessionsListData>({ queryKey: listKey });
    queryClient.setQueriesData<SessionsListData>({ queryKey: listKey }, old =>
      old && isCurrentOperation(epoch) ? update(old) : old
    );
    return { previous, generation, epoch };
  };

  /** Retitle every cached tray without changing its context or cache envelope. */
  const snapshotAndUpdateActive = async (sessionId: string, title: string, epoch: number) => {
    assertCurrentOperation(epoch);
    await queryClient.cancelQueries(activeListFilter);
    assertCurrentOperation(epoch);
    const previousActive = queryClient.getQueriesData<CachedActiveSessionsData>(activeListFilter);
    queryClient.setQueriesData<CachedActiveSessionsData>(activeListFilter, old =>
      old && isCurrentOperation(epoch)
        ? { sessions: applyActiveSessionTitle(old.sessions, sessionId, title) }
        : old
    );
    return previousActive;
  };

  const rollback = (previous: [QueryKey, unknown][] | undefined, epoch: number) => {
    for (const [key, data] of previous ?? []) {
      if (!isCurrentOperation(epoch)) {
        return;
      }
      queryClient.setQueryData(key, data);
    }
  };

  const deleteOptions = trpc.cliSessionsV2.delete.mutationOptions({
    onMutate: async input => {
      const snapshot = await snapshotAndUpdate(
        data => removeStoredSession(data, input.session_id),
        operationEpochs.get(input)
      );
      return snapshot;
    },
    onError: (error, input, context) => {
      if (!isCurrentOperation(operationEpochs.get(input))) {
        return;
      }
      if (context && isLatestMutationGeneration(hashKey(listKey), context.generation)) {
        rollback(context.previous, context.epoch);
      }
      onError(error);
    },
    onSettled: (_data, _error, input) => {
      invalidateSessions(operationEpochs.get(input));
    },
  });
  const deleteSessionMutation = useMutation({
    ...deleteOptions,
    mutationFn: async (input, context) => {
      const epoch = operationEpochs.get(input);
      assertCurrentOperation(epoch);
      if (!deleteOptions.mutationFn) {
        throw new Error('No mutationFn found');
      }
      const result = await settleCurrentOperation(epoch, deleteOptions.mutationFn(input, context));
      return result;
    },
  });

  const renameOptions = trpc.cliSessionsV2.rename.mutationOptions({
    onMutate: async input => {
      const snapshot = await snapshotAndUpdate(
        data =>
          mapStoredSessions(data, input.session_id, session => ({
            ...session,
            title: input.title,
          })),
        operationEpochs.get(input)
      );
      const previousActive = await snapshotAndUpdateActive(
        input.session_id,
        input.title,
        snapshot.epoch
      );
      return { ...snapshot, previousActive };
    },
    onError: (error, input, context) => {
      if (!isCurrentOperation(operationEpochs.get(input))) {
        return;
      }
      if (context && isLatestMutationGeneration(hashKey(listKey), context.generation)) {
        rollback(context.previous, context.epoch);
        rollback(context.previousActive, context.epoch);
      }
      onError(error);
    },
    onSettled: (_data, _error, input) => {
      invalidateSessions(operationEpochs.get(input));
    },
  });
  const renameSessionMutation = useMutation({
    ...renameOptions,
    mutationFn: async (input, context) => {
      const epoch = operationEpochs.get(input);
      assertCurrentOperation(epoch);
      if (!renameOptions.mutationFn) {
        throw new Error('No mutationFn found');
      }
      const result = await settleCurrentOperation(epoch, renameOptions.mutationFn(input, context));
      return result;
    },
  });

  // Preserve per-session sequencing and the detail caller's rejection contract.
  const renameSessionAsync = async (sessionId: string, title: string) => {
    const epoch = currentAuthEpoch();
    const input = { session_id: sessionId, title };
    operationEpochs.set(input, epoch);
    await chainSave(sessionId, async () => {
      assertCurrentOperation(epoch);
      await renameSessionMutation.mutateAsync(input);
      assertCurrentOperation(epoch);
    });
  };

  return {
    deleteSession: (sessionId: string, onDeleted?: () => void) => {
      const epoch = currentAuthEpoch();
      const input = { session_id: sessionId };
      operationEpochs.set(input, epoch);
      void (async () => {
        try {
          await chainSave(sessionId, async () => {
            assertCurrentOperation(epoch);
            await deleteSessionMutation.mutateAsync(input);
          });
          assertCurrentOperation(epoch);
          announcingToast.success(i18n.t('agents.sessionRow.sessionDeleted'));
          onDeleted?.();
        } catch {
          // Current-account failures use onError; stale outcomes stay silent.
        }
      })();
    },
    renameSession: (sessionId: string, title: string) => {
      void (async () => {
        try {
          await renameSessionAsync(sessionId, title);
        } catch {
          // Current-account failures use onError; stale outcomes stay silent.
        }
      })();
    },
    renameSessionAsync,
  };
}
