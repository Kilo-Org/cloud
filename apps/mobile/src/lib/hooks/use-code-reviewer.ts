import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import {
  buildSaveConfigInput,
  type ConfigPatch,
  PERSONAL_SCOPE,
  type ReviewConfigData,
  type ReviewerPlatform,
} from '@/lib/code-reviewer-config';
import { chainSave } from '@/lib/hooks/save-chain';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { pick } from '@/lib/utils';

export { PERSONAL_SCOPE };

function isPersonal(scope: string) {
  return scope === PERSONAL_SCOPE;
}

// chainSave keys in-flight saves by "scope:platform", so config saves for
// the same reviewer config are never in flight concurrently — each waits
// for the previous one on the same key to settle before running (see
// save-chain.ts). It's module-level there (not per-hook-instance) so it
// holds across remounts of the same screen.

// The personal router only serves github/gitlab (bitbucket is org-only by UI
// construction). This narrows a ReviewerPlatform down to what the personal
// procedures accept, without an `as` cast — the 'bitbucket' branch is dead
// whenever scope is actually personal.
function toPersonalPlatform(platform: ReviewerPlatform): 'github' | 'gitlab' {
  return platform === 'bitbucket' ? 'github' : platform;
}

// Personal and org procedures resolve to nominally distinct tRPC option
// types even when structurally identical, so we can't pick between them
// with a ternary and spread the result — TypeScript treats the branches as
// unrelated. Instead we always call both hooks (one disabled) and return
// whichever is active, mirroring the pattern in use-kiloclaw-queries.ts.

export function useGitHubStatus(scope: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.personalReviewAgent.getGitHubStatus.queryOptions(),
    enabled: isPersonal(scope),
  });
  const org = useQuery({
    ...trpc.organizations.reviewAgent.getGitHubStatus.queryOptions({ organizationId: scope }),
    enabled: !isPersonal(scope),
  });
  return isPersonal(scope) ? personal : org;
}

export function useGitHubRepositories(scope: string, enabled: boolean) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.personalReviewAgent.listGitHubRepositories.queryOptions({}),
    enabled: enabled && isPersonal(scope),
  });
  const org = useQuery({
    ...trpc.organizations.reviewAgent.listGitHubRepositories.queryOptions({
      organizationId: scope,
    }),
    enabled: enabled && !isPersonal(scope),
  });
  return isPersonal(scope) ? personal : org;
}

export function useGitLabStatus(scope: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.personalReviewAgent.getGitLabStatus.queryOptions(),
    enabled: isPersonal(scope),
  });
  const org = useQuery({
    ...trpc.organizations.reviewAgent.getGitLabStatus.queryOptions({ organizationId: scope }),
    enabled: !isPersonal(scope),
  });
  return isPersonal(scope) ? personal : org;
}

export function useGitLabRepositories(scope: string, enabled: boolean) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.personalReviewAgent.listGitLabRepositories.queryOptions({}),
    enabled: enabled && isPersonal(scope),
  });
  const org = useQuery({
    ...trpc.organizations.reviewAgent.listGitLabRepositories.queryOptions({
      organizationId: scope,
    }),
    enabled: enabled && !isPersonal(scope),
  });
  return isPersonal(scope) ? personal : org;
}

export function useReviewConfig(
  scope: string,
  platform: ReviewerPlatform
): UseQueryResult<ReviewConfigData> {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.personalReviewAgent.getReviewConfig.queryOptions({
      platform: toPersonalPlatform(platform),
    }),
    enabled: isPersonal(scope),
  });
  const org = useQuery({
    ...trpc.organizations.reviewAgent.getReviewConfig.queryOptions({
      organizationId: scope,
      platform,
    }),
    enabled: !isPersonal(scope),
  });
  // The org procedure's inferred type carries a few org/Bitbucket-only
  // fields (manuallyAddedRepositories, reviewMemoryEnabled, actionRequired)
  // beyond our shared ReviewConfigData contract — a strict structural
  // superset, so this narrowing cast is safe (same reasoning as
  // useSaveReviewConfig's getQueryData<ReviewConfigData> below).
  return (isPersonal(scope) ? personal : org) as UseQueryResult<ReviewConfigData>;
}

function useReviewConfigQueryKey(scope: string, platform: ReviewerPlatform) {
  const trpc = useTRPC();
  return isPersonal(scope)
    ? trpc.personalReviewAgent.getReviewConfig.queryKey({ platform: toPersonalPlatform(platform) })
    : trpc.organizations.reviewAgent.getReviewConfig.queryKey({
        organizationId: scope,
        platform,
      });
}

// Reads the cached config at call time rather than render time, so two
// rapid toggles each compute their "next selection" from the latest
// committed state instead of the same stale render snapshot.
export function useReviewConfigCacheReader(scope: string, platform: ReviewerPlatform) {
  const queryClient = useQueryClient();
  const queryKey = useReviewConfigQueryKey(scope, platform);
  return () => queryClient.getQueryData<ReviewConfigData>(queryKey);
}

export function useToggleReviewer(scope: string, platform: ReviewerPlatform) {
  const queryClient = useQueryClient();
  const queryKey = useReviewConfigQueryKey(scope, platform);

  return useMutation({
    mutationFn: async (vars: { isEnabled: boolean }) => {
      const result = isPersonal(scope)
        ? await trpcClient.personalReviewAgent.toggleReviewAgent.mutate({
            platform: toPersonalPlatform(platform),
            isEnabled: vars.isEnabled,
          })
        : await trpcClient.organizations.reviewAgent.toggleReviewAgent.mutate({
            organizationId: scope,
            platform,
            isEnabled: vars.isEnabled,
          });
      // The output type widens `success` to `boolean` (not a `true`
      // literal), so a domain failure here must not be treated as a
      // resolved mutation — throwing routes it to onError (toast) instead
      // of letting callers' onSuccess fire haptics/navigation as if it worked.
      if (!result.success) {
        throw new Error('Failed to update reviewer');
      }
      return result;
    },
    onMutate: async vars => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ReviewConfigData>(queryKey);
      queryClient.setQueryData<ReviewConfigData>(queryKey, old =>
        old ? { ...old, isEnabled: vars.isEnabled } : old
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      queryClient.setQueryData<ReviewConfigData>(queryKey, old =>
        old && context?.previous ? { ...old, isEnabled: context.previous.isEnabled } : old
      );
      toast.error(error.message);
    },
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

function gitLabWebhookWarningQueryKey(scope: string, platform: ReviewerPlatform) {
  return ['codeReviewerGitLabWebhookWarning', scope, platform] as const;
}

/**
 * Durable warning surfaced when a GitLab config save partially fails to
 * sync repository webhooks (`saveReviewConfig` still resolves `success:
 * true` in that case — the sync errors are nested in `webhookSync.errors`
 * and easy to miss). Stored in the query cache rather than component state
 * so it survives navigation. `useSaveReviewConfig`'s mutationFn recomputes
 * this flag from the fresh `webhookSync.errors` on every successful save
 * (including a "Retry" that just resubmits the current config), so it
 * clears itself once the sync actually succeeds — there is no separate
 * dismiss action.
 */
export function useGitLabWebhookWarning(scope: string, platform: ReviewerPlatform) {
  const queryKey = gitLabWebhookWarningQueryKey(scope, platform);
  const { data } = useQuery({
    queryKey,
    queryFn: () => false,
    initialData: false,
    staleTime: Infinity,
  });

  return { hasWebhookSyncWarning: data };
}

export function useSaveReviewConfig(scope: string, platform: ReviewerPlatform) {
  const queryClient = useQueryClient();
  const queryKey = useReviewConfigQueryKey(scope, platform);
  const webhookWarningQueryKey = gitLabWebhookWarningQueryKey(scope, platform);
  const saveChainKey = `${scope}:${platform}`;

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (patch: ConfigPatch) =>
      // Rapid taps (e.g. toggling several focus areas in a row) each send a
      // full-config snapshot; without serializing them, two in-flight saves
      // for the same scope+platform can resolve out of order and the
      // earlier response can stomp the later one's result. Chaining onto
      // the prior in-flight save for this key keeps them in order — simple
      // FIFO, no dedupe/coalescing.
      chainSave(saveChainKey, async () => {
        const config = queryClient.getQueryData<ReviewConfigData>(queryKey);
        if (!config) {
          throw new Error('Config not loaded yet');
        }
        const input = buildSaveConfigInput(platform, config, patch);
        // The personal schema only accepts numeric repository IDs (bitbucket,
        // the only string-ID platform, is org-only). Filtering keeps this a
        // type-safe narrowing rather than a cast; the personal branch is only
        // ever reached with platform !== 'bitbucket' in practice.
        const result = isPersonal(scope)
          ? await trpcClient.personalReviewAgent.saveReviewConfig.mutate({
              ...input,
              platform: toPersonalPlatform(platform),
              selectedRepositoryIds: input.selectedRepositoryIds.filter(
                (id): id is number => typeof id === 'number'
              ),
              // Same numeric-only narrowing as selectedRepositoryIds above.
              repositoryModelOverrides: input.repositoryModelOverrides.filter(
                (override): override is typeof override & { repositoryId: number } =>
                  typeof override.repositoryId === 'number'
              ),
            })
          : await trpcClient.organizations.reviewAgent.saveReviewConfig.mutate({
              ...input,
              organizationId: scope,
            });
        // Same reasoning as useToggleReviewer: `success` is typed as `boolean`,
        // not a `true` literal, so a domain failure must throw rather than
        // resolve — otherwise onSuccess callers close sheets/navigate away as
        // if the save worked.
        if (!result.success) {
          throw new Error('Failed to save review config');
        }
        if (platform === 'gitlab') {
          queryClient.setQueryData<boolean>(
            webhookWarningQueryKey,
            (result.webhookSync?.errors.length ?? 0) > 0
          );
        }
        return result;
      }),
    onMutate: async patch => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ReviewConfigData>(queryKey);
      queryClient.setQueryData<ReviewConfigData>(queryKey, old =>
        old ? { ...old, ...patch } : old
      );
      return { previous, patch };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) {
        const keys = Object.keys(context.patch) as (keyof ConfigPatch)[];
        const restoredFields = pick(context.previous, keys);
        queryClient.setQueryData<ReviewConfigData>(queryKey, old =>
          old ? { ...old, ...restoredFields } : old
        );
      }
      toast.error(error.message);
    },
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

// Discriminated provider-connection and permission state moved to
// use-reviewer-permission.ts (kept this file under the max-lines limit);
// re-exported here so existing call sites keep importing from
// use-code-reviewer without churn.
export { classifyProviderState } from '@/lib/code-reviewer-status';
export { useReviewerEditGuard, useReviewerPermission } from '@/lib/hooks/use-reviewer-permission';

// Bitbucket is org-only, so unlike the GitHub/GitLab status hooks above
// there is no personal-vs-org split here.
export function useBitbucketReadiness(scope: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.organizations.reviewAgent.getBitbucketReadiness.queryOptions({
      organizationId: scope,
    }),
    enabled: !isPersonal(scope),
  });
}

export function useConnectBitbucket(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.organizations.reviewAgent.getBitbucketReadiness.queryKey({
    organizationId: scope,
  });

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: { accessToken: string }) =>
      trpcClient.organizations.bitbucket.connect.mutate({
        organizationId: scope,
        accessToken: vars.accessToken,
      }),
    onError: error => {
      toast.error(error.message);
    },
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
}
