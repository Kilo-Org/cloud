import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { knownServerErrorMessage } from '@/lib/server-error-copy';
import { trpcClient, useTRPC } from '@/lib/trpc';

/**
 * Repositories that still have findings but are no longer reachable through the
 * GitHub integration. The server compares repository NAMES, never ids, so a
 * repository whose cached id could not be matched is not reported here.
 *
 * Personal and org procedures resolve to nominally distinct tRPC option types
 * even when structurally identical, so both hooks are always called (one
 * disabled) and the active one is returned — the pattern `use-security-agent`
 * and the audit report hook use.
 */
export function useOrphanedRepositories(scope: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getOrphanedRepositories.queryOptions(),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getOrphanedRepositories.queryOptions({
      organizationId: scope,
    }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

/**
 * Destructive and rare: deletes every recorded finding for one repository that
 * left the integration. The caller confirms with the count first, and the
 * server writes an audit entry per deleted finding.
 */
export function useDeleteFindingsByRepository(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (repoFullName: string) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.deleteFindingsByRepository.mutate({ repoFullName })
        : trpcClient.organizations.securityAgent.deleteFindingsByRepository.mutate({
            organizationId: scope,
            repoFullName,
          }),
    onSuccess: result => {
      announcingToast.success(
        i18n.t('securityAgent.orphanedFindings.cleared', {
          count: result.deletedCount,
        })
      );
    },
    onError: error => {
      announcingToast.error(knownServerErrorMessage(error) ?? i18n.t('common.somethingWentWrong'));
    },
    onSettled: async () => {
      // Both lists change: the deleted repository leaves the orphan list, and
      // the dashboard's counts drop by what was deleted.
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.securityAgent.getOrphanedRepositories.pathKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getOrphanedRepositories.pathKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.securityAgent.getDashboardStats.pathKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getDashboardStats.pathKey(),
        }),
      ]);
    },
  });
}
