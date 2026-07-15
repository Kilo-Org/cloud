import { type QueryClient } from '@tanstack/react-query';

type QueryPathFilter = {
  pathFilter: () => Parameters<QueryClient['invalidateQueries']>[0];
};

type AgentSessionTrpcQueries = {
  cliSessionsV2: {
    list: QueryPathFilter;
    recentRepositories: QueryPathFilter;
    search: QueryPathFilter;
  };
  activeSessions: {
    list: QueryPathFilter;
  };
};

/**
 * Invalidate the four exact caches a successful `createAndRun` makes stale:
 *
 * - `cliSessionsV2.list` — the user's stored session list (the new row is
 *   now owned by the caller and must show up on the next render).
 * - `cliSessionsV2.recentRepositories` — the repositories list the home
 *   screen uses to group recent activity.
 * - `cliSessionsV2.search` — the ILIKE search index over session titles and
 *   ids.
 * - `activeSessions.list` — the active-sessions poll used by the agent
 *   tabs.
 *
 * All four invalidations are dispatched in parallel via a single
 * `Promise.all` so the next render of any consumer can refetch its slice in
 * the same network round-trip.
 */
export async function invalidateAgentSessionQueries(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  trpc: AgentSessionTrpcQueries
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter()),
    queryClient.invalidateQueries(trpc.cliSessionsV2.recentRepositories.pathFilter()),
    queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter()),
    queryClient.invalidateQueries(trpc.activeSessions.list.pathFilter()),
  ]);
}
