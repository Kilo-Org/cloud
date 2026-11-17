import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { isPersonal } from '@/lib/code-reviewer-config';
import { trpcClient, useTRPC } from '@/lib/trpc';

// Bitbucket is org-only, so unlike the GitHub/GitLab status hooks there is no
// personal-vs-org split here.

/**
 * Every read a Bitbucket connection change can make stale: the reviewer
 * readiness the code-reviewer screens show, the repository lists the new
 * session form picks from (both the cached and force-fresh keys), the
 * integration status the manage surfaces read, and the hub's setup rows.
 */
function useBitbucketRefresh(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const readinessKey = trpc.organizations.reviewAgent.getBitbucketReadiness.queryKey({
    organizationId: scope,
  });
  const cachedRepositoriesKey =
    trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryKey({
      organizationId: scope,
      forceRefresh: false,
    });
  const freshRepositoriesKey = trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryKey(
    { organizationId: scope, forceRefresh: true }
  );
  const statusKey = trpc.organizations.bitbucket.getStatus.queryKey({ organizationId: scope });
  const setupStatusKey = trpc.platformIntegrations.listSetupStatus.queryKey({
    organizationId: scope,
  });
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: readinessKey }),
      queryClient.invalidateQueries({ queryKey: cachedRepositoriesKey }),
      queryClient.invalidateQueries({ queryKey: freshRepositoriesKey }),
      queryClient.invalidateQueries({ queryKey: statusKey }),
      queryClient.invalidateQueries({ queryKey: setupStatusKey }),
    ]);
}

export function useBitbucketReadiness(scope: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.organizations.reviewAgent.getBitbucketReadiness.queryOptions({
      organizationId: scope,
    }),
    enabled: !isPersonal(scope),
  });
}

/**
 * The organization's Bitbucket integration record, for the id a native
 * disconnect names. The hub's setup-status read reports whether a workspace is
 * installed but never the integration row itself.
 */
export function useBitbucketIntegrationStatus(scope: string | undefined, enabled = true) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.organizations.bitbucket.getStatus.queryOptions({ organizationId: scope ?? '' }),
    enabled: enabled && scope !== undefined && !isPersonal(scope),
  });
}

/** Connects a workspace the organization has no integration for yet. */
export function useConnectBitbucket(scope: string) {
  const refresh = useBitbucketRefresh(scope);
  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: { accessToken: string }) =>
      trpcClient.organizations.bitbucket.connect.mutate({
        organizationId: scope,
        accessToken: vars.accessToken,
      }),
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    onSuccess: () => refresh(),
  });
}

/**
 * Replaces the token of an existing integration. `connect` refuses a second
 * integration for the same organization, so an integration whose token was
 * rejected or lost a permission is repaired here instead.
 */
export function useReplaceBitbucketToken(scope: string) {
  const refresh = useBitbucketRefresh(scope);
  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: { integrationId: string; accessToken: string }) =>
      trpcClient.organizations.bitbucket.replaceToken.mutate({
        organizationId: scope,
        integrationId: vars.integrationId,
        accessToken: vars.accessToken,
      }),
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    onSuccess: () => refresh(),
  });
}

/** Re-reads the workspace's repositories when the saved token still works. */
export function useRefreshBitbucketRepositories(scope: string) {
  const refresh = useBitbucketRefresh(scope);
  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: { integrationId: string }) =>
      trpcClient.organizations.bitbucket.refreshRepositories.mutate({
        organizationId: scope,
        integrationId: vars.integrationId,
      }),
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    onSuccess: () => refresh(),
  });
}
