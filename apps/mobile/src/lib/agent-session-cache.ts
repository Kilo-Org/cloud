import { type QueryClient } from '@tanstack/react-query';

type QueryPathFilter = {
  pathFilter: () => Parameters<QueryClient['invalidateQueries']>[0];
};

type AgentSessionTrpcQueries = {
  cliSessionsV2: {
    list: QueryPathFilter;
    recentRepositories: QueryPathFilter;
  };
};

export async function invalidateAgentSessionQueries(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  trpc: AgentSessionTrpcQueries
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter()),
    queryClient.invalidateQueries(trpc.cliSessionsV2.recentRepositories.pathFilter()),
  ]);
}
