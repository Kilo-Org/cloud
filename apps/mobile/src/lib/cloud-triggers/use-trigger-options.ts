/**
 * The choices the trigger form offers: a GitHub repository, that repository's
 * cloud environments, and the agent profiles the scope owns.
 *
 * Each read is scoped the same way the form's writes are: no organization id is
 * the caller's own GitHub installation and profiles, and an organization id
 * switches all three. The reads stay idle until the caller has what the query
 * needs (a resolved scope, a chosen repository), so a form that has not chosen a
 * repository never lists every environment of the account.
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { type RepoOption } from '@/components/profiles/repo-bindings-model';
import { type EnvironmentSummaryRow } from '@/lib/cloud-environments/environment-selection';
import { useTRPC } from '@/lib/trpc';

/** The GitHub repositories a trigger can run in, in the picker's option shape. */
export function useTriggerRepositories(organizationId: string | undefined, enabled: boolean) {
  const trpc = useTRPC();
  const query = useQuery({
    ...(organizationId === undefined
      ? trpc.cloudAgentNext.listGitHubRepositories.queryOptions({ forceRefresh: false })
      : trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })),
    enabled,
  });
  const repositories = useMemo<RepoOption[]>(
    () =>
      (query.data?.repositories ?? []).map(repository => ({
        platform: 'github' as const,
        fullName: repository.fullName,
        private: repository.private,
      })),
    [query.data]
  );
  return {
    repositories,
    isLoading: enabled && query.isPending,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * The repository's environments. The trigger stores one environment id, so the
 * list is the repository's own: an environment of another repository fails the
 * server's ownership-and-repository check.
 */
export function useTriggerEnvironments(
  organizationId: string | undefined,
  repository: string
) {
  const trpc = useTRPC();
  const enabled = repository.length > 0;
  const query = useQuery(
    trpc.cloudEnvironments.list.queryOptions(
      {
        repository: { platform: 'github', fullName: repository },
        ...(organizationId === undefined ? {} : { organizationId }),
      },
      { enabled }
    )
  );
  const environments: EnvironmentSummaryRow[] = enabled ? (query.data ?? []) : [];
  return {
    environments,
    isLoading: enabled && query.isPending,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}

export type TriggerProfileOption = Readonly<{ id: string; name: string }>;

/** The scope's agent profiles, as the form's profile picker names them. */
export function useTriggerProfiles(organizationId: string | undefined, enabled: boolean) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.agentProfiles.list.queryOptions(
      organizationId === undefined ? {} : { organizationId },
      { enabled }
    )
  );
  const profiles = useMemo<TriggerProfileOption[]>(
    () => (query.data ?? []).map(profile => ({ id: profile.id, name: profile.name })),
    [query.data]
  );
  return {
    profiles,
    isLoading: enabled && query.isPending,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}
