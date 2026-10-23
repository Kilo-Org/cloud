import { useEffect } from 'react';
import { hashKey, useMutation, useQueryClient } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { type ReviewConfigData, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import {
  getRepoSelectionSender,
  isRepoSelectionEpochCurrent,
  type RepoSelectionSaveVars,
  sameSelection,
  scheduleSend,
} from '@/lib/hooks/repo-selection-senders';
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
      if (!isRepoSelectionEpochCurrent(vars.authEpoch)) {
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
      if (!isRepoSelectionEpochCurrent(vars.authEpoch)) {
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
      // The invalidation runs only while the save's epoch is current.
      if (!isRepoSelectionEpochCurrent(vars.authEpoch)) {
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

  // The mutate trigger is published only while the mount's epoch is current.
  if (isRepoSelectionEpochCurrent(epoch)) {
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
      // The resync runs only while the mount's epoch is current.
      if (!isRepoSelectionEpochCurrent(epoch)) {
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
    // The toggle writes only while its epoch is current.
    if (!isRepoSelectionEpochCurrent(epoch)) {
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
