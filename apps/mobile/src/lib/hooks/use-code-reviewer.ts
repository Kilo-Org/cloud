import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import {
  buildSaveConfigInput,
  type ConfigPatch,
  type ReviewConfigData,
  type ReviewerPlatform,
} from '@/lib/code-reviewer-config';
import { trpcClient, useTRPC } from '@/lib/trpc';

export const PERSONAL_SCOPE = 'personal';

function isPersonal(scope: string) {
  return scope === PERSONAL_SCOPE;
}

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

function pick<K extends keyof ReviewConfigData>(
  config: ReviewConfigData,
  keys: readonly K[]
): Pick<ReviewConfigData, K> {
  const result: Partial<ReviewConfigData> = {};
  for (const key of keys) {
    result[key] = config[key];
  }
  return result as Pick<ReviewConfigData, K>;
}

export function useToggleReviewer(scope: string, platform: ReviewerPlatform) {
  const queryClient = useQueryClient();
  const queryKey = useReviewConfigQueryKey(scope, platform);

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: { isEnabled: boolean }) =>
      isPersonal(scope)
        ? trpcClient.personalReviewAgent.toggleReviewAgent.mutate({
            platform: toPersonalPlatform(platform),
            isEnabled: vars.isEnabled,
          })
        : trpcClient.organizations.reviewAgent.toggleReviewAgent.mutate({
            organizationId: scope,
            platform,
            isEnabled: vars.isEnabled,
          }),
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

export function useSaveReviewConfig(scope: string, platform: ReviewerPlatform) {
  const queryClient = useQueryClient();
  const queryKey = useReviewConfigQueryKey(scope, platform);

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (patch: ConfigPatch) => {
      const config = queryClient.getQueryData<ReviewConfigData>(queryKey);
      if (!config) {
        throw new Error('Config not loaded yet');
      }
      const input = buildSaveConfigInput(platform, config, patch);
      if (isPersonal(scope)) {
        // The personal schema only accepts numeric repository IDs
        // (bitbucket, the only string-ID platform, is org-only). Filtering
        // keeps this a type-safe narrowing rather than a cast; the branch
        // is only ever reached with platform !== 'bitbucket' in practice.
        const numericSelectedRepositoryIds = input.selectedRepositoryIds.filter(
          (id): id is number => typeof id === 'number'
        );
        return trpcClient.personalReviewAgent.saveReviewConfig.mutate({
          ...input,
          platform: toPersonalPlatform(platform),
          selectedRepositoryIds: numericSelectedRepositoryIds,
        });
      }
      return trpcClient.organizations.reviewAgent.saveReviewConfig.mutate({
        ...input,
        organizationId: scope,
      });
    },
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

export function useCanEditReviewer(scope: string) {
  const trpc = useTRPC();
  const { data: orgs } = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: !isPersonal(scope),
  });
  if (isPersonal(scope)) {
    return true;
  }
  const role = orgs?.find(org => org.organizationId === scope)?.role;
  return role === 'owner' || role === 'billing_manager';
}

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
