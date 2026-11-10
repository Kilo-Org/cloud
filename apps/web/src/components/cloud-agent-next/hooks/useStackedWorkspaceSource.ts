import { skipToken, useQuery } from '@tanstack/react-query';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { useRawTRPCClient } from '@/lib/trpc/utils';

/**
 * Menu-open preflight for stacking. The provider resolves the parent branch and
 * repository head, so the menu never guesses from a truncated workspace list.
 */
export function useStackedWorkspaceSource({
  worktreeId,
  organizationId,
  enabled,
}: {
  worktreeId: string | null | undefined;
  organizationId?: string | null;
  enabled: boolean;
}) {
  const trpcClient = useRawTRPCClient();
  const parsedWorktreeId = cloudAgentWorktreeIdSchema.safeParse(worktreeId);
  const query = useQuery({
    queryKey: ['stacked-workspace-source', organizationId ?? null, worktreeId ?? null] as const,
    queryFn:
      enabled && parsedWorktreeId.success
        ? () =>
            organizationId
              ? trpcClient.organizations.cloudAgentNext.getStackedWorkspaceSource.query({
                  organizationId,
                  worktreeId: parsedWorktreeId.data,
                })
              : trpcClient.cloudAgentNext.getStackedWorkspaceSource.query({
                  worktreeId: parsedWorktreeId.data,
                })
        : skipToken,
    enabled: enabled && parsedWorktreeId.success,
    staleTime: 15_000,
    retry: false,
  });
  return {
    ...query,
    source: query.data,
  };
}
