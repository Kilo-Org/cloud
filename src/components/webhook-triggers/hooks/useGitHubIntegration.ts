import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

/**
 * Hook for checking GitHub integration status.
 * Returns whether the integration is missing and any error message.
 */
export function useGitHubIntegration(organizationId?: string) {
  const trpc = useTRPC();

  const query = useQuery(
    organizationId
      ? trpc.organizations.cloudAgent.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgent.listGitHubRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  const isIntegrationMissing = !query.isLoading && query.data?.integrationInstalled === false;

  return {
    isLoading: query.isLoading,
    isIntegrationMissing,
    errorMessage: query.data?.errorMessage,
  };
}
