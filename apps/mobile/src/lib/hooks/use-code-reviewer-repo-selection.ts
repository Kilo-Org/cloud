import { useEffect } from 'react';
import { hashKey, useMutation, useQueryClient } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { type ReviewConfigData, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { chainSave } from '@/lib/hooks/save-chain';
import { trpcClient } from '@/lib/trpc';

import {
  gitLabWebhookWarningQueryKey,
  isPersonal,
  toNumericRepositoryIds,
  toPersonalPlatform,
  useReviewConfigCacheReader,
  useReviewConfigQueryKey,
} from './use-code-reviewer';

export const REPO_SELECTION_DEBOUNCE_MS = 500;

type RepoSelectionDelta = {
  add: (number | string)[];
  remove: (number | string)[];
};

type RepoSelectionSaveVars = RepoSelectionDelta & {
  optimisticSelection: (number | string)[];
  // The auth epoch that armed this send. A save that settles after a sign-out
  // or an account change belongs to the account that left, so its callbacks
  // must not write the next account's baseline, cache, or toast.
  authEpoch: number;
};

type RepoSelectionSender = {
  timer: ReturnType<typeof setTimeout> | null;
  // The latest user-intended selection. Null means no toggle is pending.
  pendingSelection: (number | string)[] | null;
  // The last server-confirmed selection. Null means the server state is not
  // yet known (no toggle and no refetch have synced it).
  serverSelection: (number | string)[] | null;
  // The mutation trigger of the hook instance that currently owns this key.
  mutate: ((vars: RepoSelectionSaveVars) => void) | null;
  // The auth epoch this sender's selections belong to.
  epoch: number;
};

// One pending debounced send per scope+platform, owned by the auth epoch that
// created it. The timer closes over the sender state, so a remount never
// retargets an older timer. `serverSelection` is the last server-confirmed
// selection; `pendingSelection` is the latest user-intended selection and is
// null while nothing is pending. An entry from an earlier epoch is dropped
// before it is read, so the previous account's selections can never become the
// next account's baseline.
const repoSelectionSenders = new Map<string, RepoSelectionSender>();

/**
 * True while `epoch` still owns the debounce state: the auth epoch is current
 * and no sign-out teardown is in flight. Every read of the module-level sender
 * state passes this fence, so a fire, a refetch resync, or a save completion
 * from the previous account cannot write the next one's state.
 */
function isEpochCurrent(epoch: number): boolean {
  return isCurrentAuthEpoch(epoch) && !isSignOutActive();
}

function getRepoSelectionSender(key: string, epoch: number): RepoSelectionSender {
  const existing = repoSelectionSenders.get(key);
  if (existing?.epoch === epoch) {
    return existing;
  }
  clearTimeout(existing?.timer ?? undefined);
  const sender: RepoSelectionSender = {
    timer: null,
    pendingSelection: null,
    serverSelection: null,
    mutate: null,
    epoch,
  };
  repoSelectionSenders.set(key, sender);
  return sender;
}

/**
 * Drops every pending debounced send together with its armed timer.
 * `clearSessionScopedState` calls this at both account boundaries, so a toggle
 * left inside the debounce window dies with the account that made it instead of
 * reaching the next one.
 */
export function clearRepoSelectionSenders(): void {
  for (const sender of repoSelectionSenders.values()) {
    clearTimeout(sender.timer ?? undefined);
  }
  repoSelectionSenders.clear();
}

function sameSelection(a: (number | string)[] | null, b: (number | string)[] | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every(id => b.includes(id));
}

// Schedules the trailing-edge 500ms send. The delta is computed at fire time
// from the module-level pending/server selections, so no intermediate rapid
// toggle is lost and a refetch that clobbers the optimistic cache cannot
// collapse the send to an empty delta.
function scheduleSend(sender: RepoSelectionSender): void {
  if (sender.timer) {
    clearTimeout(sender.timer);
  }
  sender.timer = setTimeout(() => {
    sender.timer = null;
    // A fire that lands after a sign-out or an account change belongs to the
    // account that left: drop the intent instead of submitting a delta under
    // whoever is signed in now.
    if (!isEpochCurrent(sender.epoch)) {
      sender.pendingSelection = null;
      return;
    }
    const pending = sender.pendingSelection;
    const server = sender.serverSelection ?? [];
    if (pending === null) {
      return;
    }
    const add = pending.filter(id => !server.includes(id));
    const remove = server.filter(id => !pending.includes(id));
    if (add.length === 0 && remove.length === 0) {
      // The intent now equals the server state, so nothing is left to send.
      // Clear it so a later refetch does not mistake it for live user intent.
      sender.pendingSelection = null;
      return;
    }
    sender.mutate?.({ add, remove, optimisticSelection: pending, authEpoch: sender.epoch });
  }, REPO_SELECTION_DEBOUNCE_MS);
}

/**
 * Sends a `selectedRepositoryDelta` patch without touching the optimistic
 * cache: the delta is a diff, not a config field, so it must never be merged
 * into the cached `ReviewConfigData` the way a full-array `ConfigPatch` is.
 */
function useSaveReviewConfigDelta(scope: string, platform: ReviewerPlatform) {
  const queryClient = useQueryClient();
  const queryKey = useReviewConfigQueryKey(scope, platform);
  const webhookWarningQueryKey = gitLabWebhookWarningQueryKey(scope, platform);
  const saveChainKey = `${scope}:${platform}`;

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: RepoSelectionSaveVars) =>
      chainSave(saveChainKey, async () => {
        // The personal schema only accepts numeric repository IDs (bitbucket,
        // the only string-ID platform, is org-only). Same narrowing as
        // useSaveReviewConfig's full-array path.
        const gitlabAutoConfigure =
          platform === 'gitlab' ? ({ autoConfigureWebhooks: true } as const) : ({} as const);
        const result = isPersonal(scope)
          ? await trpcClient.personalReviewAgent.patchReviewConfig.mutate({
              platform: toPersonalPlatform(platform),
              selectedRepositoryDelta: {
                add: toNumericRepositoryIds(vars.add),
                remove: toNumericRepositoryIds(vars.remove),
              },
              ...gitlabAutoConfigure,
            })
          : await trpcClient.organizations.reviewAgent.patchReviewConfig.mutate({
              organizationId: scope,
              platform,
              selectedRepositoryDelta: { add: vars.add, remove: vars.remove },
              ...gitlabAutoConfigure,
            });
        if (!result.success) {
          throw new Error(i18n.t('codeReviewer.configSaveFailed'));
        }
        if (platform === 'gitlab') {
          queryClient.setQueryData<boolean>(
            webhookWarningQueryKey,
            (result.webhookSync?.errors.length ?? 0) > 0
          );
        }
        return result;
      }),
    onError: (error, vars) => {
      if (!isEpochCurrent(vars.authEpoch)) {
        return;
      }
      const sender = getRepoSelectionSender(saveChainKey, vars.authEpoch);
      // Roll back only when no newer toggle superseded this failed save. A
      // newer toggle's own debounced send reconciles against the unchanged
      // server state, so clobbering it here would lose that selection.
      if (
        sender.pendingSelection !== null &&
        sameSelection(sender.pendingSelection, vars.optimisticSelection)
      ) {
        const serverSelection = sender.serverSelection;
        if (serverSelection !== null) {
          queryClient.setQueryData<ReviewConfigData>(queryKey, old =>
            old ? { ...old, selectedRepositoryIds: serverSelection } : old
          );
        }
        sender.pendingSelection = null;
      }
      announcingToast.error(error.message);
    },
    onSuccess: (_result, vars) => {
      if (!isEpochCurrent(vars.authEpoch)) {
        return;
      }
      const sender = getRepoSelectionSender(saveChainKey, vars.authEpoch);
      sender.serverSelection = vars.optimisticSelection;
      // Clear the pending intent only when it matches what this save just
      // confirmed; a newer toggle keeps its own pending send alive.
      if (
        sender.pendingSelection !== null &&
        sameSelection(sender.pendingSelection, vars.optimisticSelection)
      ) {
        sender.pendingSelection = null;
      }
    },
    onSettled: async (_data, _error, vars) => {
      // A save owned by an account that left must not refetch, or it would
      // pull the next account's config through a stale save's completion.
      if (!isEpochCurrent(vars.authEpoch)) {
        return;
      }
      await queryClient.invalidateQueries({ queryKey });
    },
  });
}

/**
 * Returns a `toggleRepo` that applies the optimistic cache update immediately
 * and schedules a trailing-edge 500ms debounced delta send keyed on
 * scope+platform. The delta is computed at send time against the last
 * server-confirmed selection, so no intermediate rapid toggle is lost.
 */
export function useRepoSelectionToggle(scope: string, platform: ReviewerPlatform) {
  const queryClient = useQueryClient();
  const queryKey = useReviewConfigQueryKey(scope, platform);
  const senderKey = `${scope}:${platform}`;
  const readConfig = useReviewConfigCacheReader(scope, platform);
  const deltaSave = useSaveReviewConfigDelta(scope, platform);
  const epoch = currentAuthEpoch();

  // Only the account that owns the current epoch may publish its trigger into
  // the sender: a mount that outlived its account must not retarget the entry
  // the next account is using.
  if (isEpochCurrent(epoch)) {
    getRepoSelectionSender(senderKey, epoch).mutate = deltaSave.mutate;
  }
  const queryKeyHash = hashKey(queryKey);

  useEffect(() => {
    const queryCache = queryClient.getQueryCache();
    return queryCache.subscribe(event => {
      if (event.type !== 'updated' || event.action.type !== 'success') {
        return;
      }
      // Our own optimistic setQueryData also dispatches a success action with
      // `manual: true`; only a real fetch (refetch) resyncs the baseline.
      if (event.action.manual) {
        return;
      }
      if (event.query.queryHash !== queryKeyHash) {
        return;
      }
      const fetched = (event.action.data as ReviewConfigData | undefined)?.selectedRepositoryIds;
      if (fetched === undefined) {
        return;
      }
      // A refetch that lands after a sign-out or account change answers for
      // the account that left: it must not seed this epoch's baseline nor
      // re-apply its pending selection to the next account's cache.
      if (!isEpochCurrent(epoch)) {
        return;
      }
      // Resync the baseline with the refetched server selection. If a user
      // toggle is still pending and differs from the fetched state, re-apply
      // it to the cache and re-schedule the send so the toggle reaches the
      // server and stays visible.
      const refetchedSender = getRepoSelectionSender(senderKey, epoch);
      refetchedSender.serverSelection = fetched;
      const pending = refetchedSender.pendingSelection;
      if (pending !== null && !sameSelection(pending, fetched)) {
        queryClient.setQueryData<ReviewConfigData>(queryKey, old =>
          old ? { ...old, selectedRepositoryIds: pending } : old
        );
        scheduleSend(refetchedSender);
      }
    });
    // eslint-disable-next-line react/exhaustive-deps -- queryKey is derived from queryKeyHash; re-subscribing on every render would churn the cache listener
  }, [queryClient, queryKeyHash, senderKey, epoch]);

  return (id: number | string) => {
    // A toggle that reaches a mount whose account already left writes to no
    // account at all: the entry belongs to the current epoch only.
    if (!isEpochCurrent(epoch)) {
      return;
    }
    const current = readConfig()?.selectedRepositoryIds ?? [];
    const next = current.includes(id)
      ? current.filter(existing => existing !== id)
      : [...current, id];

    const currentSender = getRepoSelectionSender(senderKey, epoch);
    // First toggle: the pre-optimistic cache is the server-confirmed value.
    currentSender.serverSelection ??= current;
    currentSender.pendingSelection = next;

    queryClient.setQueryData<ReviewConfigData>(queryKey, old =>
      old ? { ...old, selectedRepositoryIds: next } : old
    );

    scheduleSend(currentSender);
  };
}
