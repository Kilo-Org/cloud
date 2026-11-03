import { queryOptions, skipToken } from '@tanstack/react-query';
import type { TRPCClient } from '@trpc/client';
import type { TRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { CloudAgentWorktreeId } from '@kilocode/session-ingest-contracts';
import type { RootRouter } from '@/routers/root-router';

export function worktreeParentQueryOptions({
  trpc,
  client,
  userId,
  worktreeId,
  organizationId,
}: {
  trpc: Pick<TRPCOptionsProxy<RootRouter>, 'cliSessionsV2'>;
  client: Pick<TRPCClient<RootRouter>, 'cliSessionsV2'>;
  userId: string;
  worktreeId: CloudAgentWorktreeId | null;
  organizationId: string | null;
}) {
  const input = worktreeId ? { worktreeId, organizationId } : skipToken;
  const options = trpc.cliSessionsV2.worktreeParent.queryOptions(input);

  return queryOptions({
    queryKey: [[...options.queryKey[0], userId], options.queryKey[1]] as const,
    staleTime: 60_000,
    queryFn:
      input === skipToken
        ? skipToken
        : ({ signal }: { signal: AbortSignal }) =>
            client.cliSessionsV2.worktreeParent.query(input, { signal }),
  });
}
