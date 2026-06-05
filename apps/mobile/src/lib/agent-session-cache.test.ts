import { describe, expect, it, vi } from 'vitest';

import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';

describe('invalidateAgentSessionQueries', () => {
  it('invalidates session list and recent repository queries', async () => {
    const listFilter = { queryKey: ['cliSessionsV2', 'list'] };
    const recentRepositoriesFilter = { queryKey: ['cliSessionsV2', 'recentRepositories'] };
    const queryClient = {
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
    };
    const trpc = {
      cliSessionsV2: {
        list: { pathFilter: () => listFilter },
        recentRepositories: { pathFilter: () => recentRepositoriesFilter },
      },
    };

    await invalidateAgentSessionQueries(queryClient, trpc);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith(listFilter);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith(recentRepositoriesFilter);
  });
});
