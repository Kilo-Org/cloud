import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { trpcClient, useTRPC } from '@/lib/trpc';

import { isRepoSelectionEpochCurrent } from './repo-selection-senders';
import { isPersonal } from './use-code-reviewer';

/** Platforms whose repository list has a provider read behind it. */
export type SyncedRepoPlatform = 'github' | 'gitlab';

export type ReviewerRepositoriesResync = {
  /** Re-reads the provider list, stores the snapshot, and resolves when done. */
  resync: () => Promise<void>;
  /** True while a forced read is in flight; drives the pull and button waits. */
  resyncing: boolean;
};

/**
 * The picker's plain read answers from the integration snapshot, so a widened
 * installation or a repository created after the last sync never appears. This
 * forces one provider read with the same procedure the read uses, then writes
 * the answer into that query's cache so the open list updates in place.
 *
 * One forced read runs at a time: the button and the pull both land here.
 */
export function useReviewerRepositoriesResync(
  scope: string,
  platform: SyncedRepoPlatform
): ReviewerRepositoriesResync {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [resyncing, setResyncing] = useState(false);
  const inFlight = useRef(false);

  const resync = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setResyncing(true);
    // The snapshot is stored only while the epoch captured here is current,
    // the same fence the selection hooks in use-code-reviewer-repo-selection.ts
    // apply to their writes.
    const epoch = currentAuthEpoch();
    const storeIfCurrent = (store: () => void) => {
      if (isRepoSelectionEpochCurrent(epoch)) {
        store();
      }
    };
    try {
      // Each branch stays written out: tRPC types the personal and the
      // organization procedure options nominally, so a shared helper around the
      // read and the key would erase that type.
      if (platform === 'github') {
        if (isPersonal(scope)) {
          const repositories = await trpcClient.personalReviewAgent.listGitHubRepositories.query({
            forceRefresh: true,
          });
          storeIfCurrent(() => {
            queryClient.setQueryData(
              trpc.personalReviewAgent.listGitHubRepositories.queryOptions({}).queryKey,
              repositories
            );
          });
        } else {
          const repositories =
            await trpcClient.organizations.reviewAgent.listGitHubRepositories.query({
              organizationId: scope,
              forceRefresh: true,
            });
          storeIfCurrent(() => {
            queryClient.setQueryData(
              trpc.organizations.reviewAgent.listGitHubRepositories.queryOptions({
                organizationId: scope,
              }).queryKey,
              repositories
            );
          });
        }
      } else if (isPersonal(scope)) {
        const repositories = await trpcClient.personalReviewAgent.listGitLabRepositories.query({
          forceRefresh: true,
        });
        storeIfCurrent(() => {
          queryClient.setQueryData(
            trpc.personalReviewAgent.listGitLabRepositories.queryOptions({}).queryKey,
            repositories
          );
        });
      } else {
        const repositories =
          await trpcClient.organizations.reviewAgent.listGitLabRepositories.query({
            organizationId: scope,
            forceRefresh: true,
          });
        storeIfCurrent(() => {
          queryClient.setQueryData(
            trpc.organizations.reviewAgent.listGitLabRepositories.queryOptions({
              organizationId: scope,
            }).queryKey,
            repositories
          );
        });
      }
    } catch {
      // The previous rows stay: a failed forced read is not a reason to empty
      // a list the user can still select from, and only a current refresh
      // reports its failure.
      if (isRepoSelectionEpochCurrent(epoch)) {
        toast.error(t('common.couldNotRefresh'));
      }
    } finally {
      inFlight.current = false;
      setResyncing(false);
    }
  }, [platform, queryClient, scope, t, trpc]);

  return { resync, resyncing };
}
