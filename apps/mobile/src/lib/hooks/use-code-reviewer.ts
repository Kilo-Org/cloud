import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import {
  buildSaveConfigInput,
  type ConfigPatch,
  type ReviewConfigData,
} from '@/lib/code-reviewer-config';
import { trpcClient, useTRPC } from '@/lib/trpc';

export const PERSONAL_SCOPE = 'personal';

function isPersonal(scope: string) {
  return scope === PERSONAL_SCOPE;
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

export function useReviewConfig(scope: string): UseQueryResult<ReviewConfigData> {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.personalReviewAgent.getReviewConfig.queryOptions({ platform: 'github' }),
    enabled: isPersonal(scope),
  });
  const org = useQuery({
    ...trpc.organizations.reviewAgent.getReviewConfig.queryOptions({
      organizationId: scope,
      platform: 'github',
    }),
    enabled: !isPersonal(scope),
  });
  // The org procedure also serves Bitbucket (string repo IDs), so its
  // inferred type is broader than our GitHub-only ReviewConfigData
  // contract. We always request platform: 'github' above, which
  // guarantees this shape at runtime (same reasoning as
  // useSaveReviewConfig's getQueryData<ReviewConfigData> below).
  return (isPersonal(scope) ? personal : org) as UseQueryResult<ReviewConfigData>;
}

function useReviewConfigQueryKey(scope: string) {
  const trpc = useTRPC();
  return isPersonal(scope)
    ? trpc.personalReviewAgent.getReviewConfig.queryKey({ platform: 'github' })
    : trpc.organizations.reviewAgent.getReviewConfig.queryKey({
        organizationId: scope,
        platform: 'github',
      });
}

// Reads the cached config at call time rather than render time, so two
// rapid toggles each compute their "next selection" from the latest
// committed state instead of the same stale render snapshot.
export function useReviewConfigCacheReader(scope: string) {
  const queryClient = useQueryClient();
  const queryKey = useReviewConfigQueryKey(scope);
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

export function useToggleReviewer(scope: string) {
  const queryClient = useQueryClient();
  const queryKey = useReviewConfigQueryKey(scope);

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: { isEnabled: boolean }) =>
      isPersonal(scope)
        ? trpcClient.personalReviewAgent.toggleReviewAgent.mutate({
            platform: 'github',
            isEnabled: vars.isEnabled,
          })
        : trpcClient.organizations.reviewAgent.toggleReviewAgent.mutate({
            organizationId: scope,
            platform: 'github',
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

export function useSaveReviewConfig(scope: string) {
  const queryClient = useQueryClient();
  const queryKey = useReviewConfigQueryKey(scope);

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (patch: ConfigPatch) => {
      // The org endpoint also serves Bitbucket, whose repository IDs are
      // strings, so its inferred output type is broader than our
      // GitHub-only ReviewConfigData contract. We always request
      // platform: 'github' here, which guarantees numeric IDs at runtime.
      const config = queryClient.getQueryData<ReviewConfigData>(queryKey);
      if (!config) {
        throw new Error('Config not loaded yet');
      }
      const input = buildSaveConfigInput(config, patch);
      return isPersonal(scope)
        ? trpcClient.personalReviewAgent.saveReviewConfig.mutate(input)
        : trpcClient.organizations.reviewAgent.saveReviewConfig.mutate({
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
