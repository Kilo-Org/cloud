import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { toast } from 'sonner-native';

import { mergeRepositoryOptions, type RepoOption } from '@/components/profiles/repo-bindings-model';
import { withOrganization } from '@/lib/hooks/agent-profile-mutation-helpers';
import { type AgentRepoBinding } from '@/lib/hooks/agent-profile-types';
import { keepPreviousDataForQueryKey } from '@/lib/hooks/use-agent-profiles';
import { useTRPC } from '@/lib/trpc';

/** Stable empty fallbacks so an unsettled result is not a new array each render. */
const NO_BINDINGS: AgentRepoBinding[] = [];
const NO_REPOSITORIES: RepoOption[] = [];

/**
 * The repo bindings for a context. Personal context reads
 * `listRepoBindings({})`; org context carries `organizationId`, exactly like
 * every other `agentProfiles.*` input.
 *
 * `placeholderData` keeps the rows across a refetch of the same key, so the
 * list never blanks while an unbind reconciles; a different key (an
 * organization switch) starts empty instead of showing another scope's rows
 * while `useRepoBindingMutations` already targets the new scope. `isLoading` is
 * `isPending`, not React Query v5's `isLoading`, so an offline first fetch still
 * counts as unloaded rather than empty.
 */
export function useRepoBindings(organizationId?: string) {
  const trpc = useTRPC();
  const options = trpc.agentProfiles.listRepoBindings.queryOptions(
    organizationId === undefined ? {} : { organizationId }
  );
  const query = useQuery({
    ...options,
    placeholderData: keepPreviousDataForQueryKey(options.queryKey),
  });

  return {
    bindings: query.data ?? NO_BINDINGS,
    isLoading: query.isPending,
    isError: query.isError,
    isRefetching: query.isRefetching,
    refetch: query.refetch,
  };
}

/**
 * The bind and unbind mutations. Each carries the hook's organization context,
 * toasts a failed server call exactly once (the screen only fills in a fallback
 * when the server sent no readable message), and invalidates the
 * `listRepoBindings` namespace so both the bindings list and the Overview pins
 * section reconcile with server truth.
 */
export function useRepoBindingMutations(organizationId?: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const bindingsFilter = trpc.agentProfiles.listRepoBindings.pathFilter();

  const callbacks = {
    onSuccess: () => {
      void queryClient.invalidateQueries(bindingsFilter);
    },
    onError: (error: { message: string }) => {
      toast.error(error.message);
    },
  };

  const bind = useMutation(
    withOrganization(trpc.agentProfiles.bindToRepo.mutationOptions(callbacks), organizationId)
  );
  const unbind = useMutation(
    withOrganization(trpc.agentProfiles.unbindRepo.mutationOptions(callbacks), organizationId)
  );

  return { bind, unbind };
}

/**
 * The merged GitHub + GitLab repository options the Add form's repo picker
 * shows. The queries run only while `enabled` (the picker is open), matching the
 * web dialog's lazy fetch. GitHub rows come first, then GitLab.
 */
export function useRepoOptions(organizationId: string | undefined, enabled: boolean) {
  const trpc = useTRPC();

  const github = useQuery({
    ...(organizationId === undefined
      ? trpc.cloudAgentNext.listGitHubRepositories.queryOptions({ forceRefresh: false })
      : trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })),
    enabled,
  });
  const gitlab = useQuery({
    ...(organizationId === undefined
      ? trpc.cloudAgentNext.listGitLabRepositories.queryOptions({ forceRefresh: false })
      : trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })),
    enabled,
  });

  const repositories = useMemo(
    () =>
      enabled
        ? mergeRepositoryOptions(
            github.data?.repositories ?? NO_REPOSITORIES,
            gitlab.data?.repositories ?? NO_REPOSITORIES
          )
        : NO_REPOSITORIES,
    [enabled, github.data, gitlab.data]
  );

  return {
    repositories,
    isLoading: enabled && (github.isPending || gitlab.isPending),
    isError: github.isError || gitlab.isError,
    isRefetching: github.isRefetching || gitlab.isRefetching,
    refetch: () => {
      void github.refetch();
      void gitlab.refetch();
    },
  };
}
