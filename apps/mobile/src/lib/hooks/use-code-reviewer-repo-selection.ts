import { useEffect } from 'react';
import { hashKey, useMutation, useQueryClient } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
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
};

type RepoSelectionSender = {
  timer: ReturnType<typeof setTimeout> | null;
  // The latest user-intended selection. Null means no toggle is pending.
  pendingSelection: (number | string)[] | null;
  // The last server-confirmed selection. Null means the server state is not
  // yet known (no toggle and no refetch have synced it).
  serverSelection: (number | string)[] | null;
  // The optimistic selection of the most recently enqueued save: what the
  // server will hold once every in-flight save applies. Null when no save is
  // in flight. Deltas diff against this, not the not-yet-advanced confirmed
  // baseline, so a toggle made while a save is in flight is not lost.
  projectedSelection: (number | string)[] | null;
  // Enqueued saves that have not settled yet. `projectedSelection` is cleared
  // when this returns to zero.
  inflightSaves: number;
  // The mutation trigger of the hook instance that currently owns this key.
  mutate: ((vars: RepoSelectionSaveVars) => void) | null;
};

// One pending debounced send per scope+platform. The timer closes over the
// sender state, so a remount never retargets an older timer. `serverSelection`
// is the last server-confirmed selection; `projectedSelection` is what the
// server will hold once every in-flight save applies; `pendingSelection` is the
// latest user-intended selection and is null while nothing is pending.
const repoSelectionSenders = new Map<string, RepoSelectionSender>();

function getRepoSelectionSender(key: string): RepoSelectionSender {
  let sender = repoSelectionSenders.get(key);
  if (!sender) {
    sender = {
      timer: null,
      pendingSelection: null,
      serverSelection: null,
      projectedSelection: null,
      inflightSaves: 0,
      mutate: null,
    };
    repoSelectionSenders.set(key, sender);
  }
  return sender;
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

// Applies a settled save's own delta to the confirmed baseline. A save must
// advance `serverSelection` by the delta it actually sent, not by adopting its
// optimistic selection: a superseded in-flight save may have failed, so the
// optimistic selection can contain ids this save never sent. Adopting it would
// mark those ids server-confirmed and the reconciliation diff would never
// re-send them.
function applyDelta(base: (number | string)[], delta: RepoSelectionDelta): (number | string)[] {
  const removed = new Set(delta.remove);
  const kept = base.filter(id => !removed.has(id));
  return [...kept, ...delta.add.filter(id => !kept.includes(id))];
}

// Schedules the trailing-edge 500ms send. The delta is computed at fire time
// from the module-level pending and projected/server selections, so no
// intermediate rapid toggle is lost and a refetch that clobbers the optimistic
// cache cannot collapse the send to an empty delta.
function scheduleSend(sender: RepoSelectionSender): void {
  if (sender.timer) {
    clearTimeout(sender.timer);
  }
  sender.timer = setTimeout(() => {
    sender.timer = null;
    const pending = sender.pendingSelection;
    if (pending === null) {
      return;
    }
    // Diff against what the server will hold once every in-flight save
    // applies. Diffing against `serverSelection` alone collapses a deselect
    // made while its add is still in flight to an empty delta (the server
    // baseline has not advanced yet), which drops the deselect.
    const baseline = sender.projectedSelection ?? sender.serverSelection ?? [];
    const add = pending.filter(id => !baseline.includes(id));
    const remove = baseline.filter(id => !pending.includes(id));
    if (add.length === 0 && remove.length === 0) {
      // The intent now equals what the server is (or will be) holding. While
      // a save is still in flight the projection may yet advance, so keep the
      // intent and let that save's settlement reconcile it. Otherwise clear it
      // so a later refetch does not mistake it for live user intent.
      if (sender.inflightSaves === 0) {
        sender.pendingSelection = null;
      }
      return;
    }
    if (!sender.mutate) {
      return;
    }
    // Record the projection before dispatching so the next delta diffs against
    // what this save will apply.
    sender.projectedSelection = pending;
    sender.inflightSaves += 1;
    sender.mutate({ add, remove, optimisticSelection: pending });
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
      const sender = getRepoSelectionSender(saveChainKey);
      sender.inflightSaves = Math.max(0, sender.inflightSaves - 1);
      if (sender.inflightSaves === 0) {
        // No save is in flight; the confirmed baseline is authoritative again.
        sender.projectedSelection = null;
      }
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
      const sender = getRepoSelectionSender(saveChainKey);
      // Advance the confirmed baseline by this save's own delta, not by
      // adopting its optimistic selection. A superseded in-flight save may have
      // failed, so the optimistic selection can contain ids this save never
      // sent; treating those as confirmed would hide them from the
      // reconciliation diff below and drop the user's still-intended selection.
      sender.serverSelection = applyDelta(sender.serverSelection ?? [], vars);
      sender.inflightSaves = Math.max(0, sender.inflightSaves - 1);
      if (sender.inflightSaves === 0) {
        // No save is in flight; the confirmed baseline is authoritative again.
        sender.projectedSelection = null;
      }
      if (sender.pendingSelection === null) {
        return;
      }
      // Keep the pending intent until every in-flight save has settled. It is
      // not confirmed merely because it matches the projected selection: that
      // projection belongs to an in-flight save, and if that save fails there
      // is nothing left for onError to roll back, so the failed optimistic
      // selection would stay in the cache. The intent is only safe to clear
      // once no save remains in flight and the server holds it.
      if (sender.inflightSaves === 0) {
        if (sameSelection(sender.pendingSelection, sender.serverSelection)) {
          sender.pendingSelection = null;
        } else {
          // No save carries the intent and the server does not hold it; send it.
          scheduleSend(sender);
        }
        return;
      }
      // A newer save is still in flight. If it already carries the pending
      // intent the projection will confirm it; otherwise reschedule against the
      // advanced baseline so the intent reaches the server.
      if (!sameSelection(sender.pendingSelection, sender.projectedSelection)) {
        scheduleSend(sender);
      }
    },
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

/**
 * Returns a `toggleRepo` that applies the optimistic cache update immediately
 * and schedules a trailing-edge 500ms debounced delta send keyed on
 * scope+platform. The delta is computed at send time against what the server
 * will hold once every in-flight save applies (falling back to the last
 * server-confirmed selection), so no intermediate rapid toggle is lost and a
 * toggle made while a save is in flight is not dropped.
 */
export function useRepoSelectionToggle(scope: string, platform: ReviewerPlatform) {
  const queryClient = useQueryClient();
  const queryKey = useReviewConfigQueryKey(scope, platform);
  const senderKey = `${scope}:${platform}`;
  const readConfig = useReviewConfigCacheReader(scope, platform);
  const deltaSave = useSaveReviewConfigDelta(scope, platform);

  const sender = getRepoSelectionSender(senderKey);
  sender.mutate = deltaSave.mutate;

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
      // Resync the baseline with the refetched server selection. If a user
      // toggle is still pending and differs from the fetched state, re-apply
      // it to the cache and re-schedule the send so the toggle reaches the
      // server and stays visible.
      const refetchedSender = getRepoSelectionSender(senderKey);
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
  }, [queryClient, queryKeyHash, senderKey]);

  return (id: number | string) => {
    const current = readConfig()?.selectedRepositoryIds ?? [];
    const next = current.includes(id)
      ? current.filter(existing => existing !== id)
      : [...current, id];

    const currentSender = getRepoSelectionSender(senderKey);
    // First toggle: the pre-optimistic cache is the server-confirmed value.
    currentSender.serverSelection ??= current;
    currentSender.pendingSelection = next;

    queryClient.setQueryData<ReviewConfigData>(queryKey, old =>
      old ? { ...old, selectedRepositoryIds: next } : old
    );

    scheduleSend(currentSender);
  };
}

// Test-only: cancels every pending debounced timer and clears the sender
// state so a test never leaks a fire into a later case (same pattern as
// resetDraftTimersForTests in drafts.ts).
export function resetRepoSelectionSendersForTests(): void {
  for (const sender of repoSelectionSenders.values()) {
    if (sender.timer) {
      clearTimeout(sender.timer);
    }
  }
  repoSelectionSenders.clear();
}
