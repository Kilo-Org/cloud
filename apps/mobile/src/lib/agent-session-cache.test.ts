import { describe, expect, it, vi } from 'vitest';

import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';

const reconcileFirstPageMock =
  vi.fn<(queryClient: unknown, queryKeyPrefix: readonly unknown[]) => void>();

vi.mock('@/lib/query/infinite-retention', () => ({
  reconcileFirstPage: (queryClient: unknown, queryKeyPrefix: readonly unknown[]) => {
    reconcileFirstPageMock(queryClient, queryKeyPrefix);
  },
}));

describe('invalidateAgentSessionQueries', () => {
  it('reconciles the session list to page one and invalidates recent repository and active session queries', async () => {
    const listFilter = { queryKey: ['cliSessionsV2', 'list'] };
    const recentRepositoriesFilter = { queryKey: ['cliSessionsV2', 'recentRepositories'] };
    const activeListFilter = { queryKey: ['activeSessions', 'list'] };
    const queryClient = {
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
      setQueriesData: vi.fn(),
    };
    const trpc = {
      cliSessionsV2: {
        list: { pathFilter: () => listFilter },
        recentRepositories: { pathFilter: () => recentRepositoriesFilter },
      },
      activeSessions: {
        list: { pathFilter: () => activeListFilter },
      },
    };

    await invalidateAgentSessionQueries(queryClient, trpc);

    // The stored list is reconciled to page one, not wholesale-invalidated.
    expect(reconcileFirstPageMock).toHaveBeenCalledWith(queryClient, listFilter.queryKey);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith(listFilter);
    // The other two keys keep their plain invalidation.
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith(recentRepositoriesFilter);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith(activeListFilter);
  });
});
