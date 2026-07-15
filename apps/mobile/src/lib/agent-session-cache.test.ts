import { describe, expect, it, vi } from 'vitest';

import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';

describe('invalidateAgentSessionQueries', () => {
  it('invalidates list, recentRepositories, search, and activeSessions in one Promise.all', async () => {
    const listFilter = { queryKey: ['cliSessionsV2', 'list'] };
    const recentRepositoriesFilter = { queryKey: ['cliSessionsV2', 'recentRepositories'] };
    const searchFilter = { queryKey: ['cliSessionsV2', 'search'] };
    const activeSessionsFilter = { queryKey: ['activeSessions', 'list'] };
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const queryClient = { invalidateQueries };
    const trpc = {
      cliSessionsV2: {
        list: { pathFilter: () => listFilter },
        recentRepositories: { pathFilter: () => recentRepositoriesFilter },
        search: { pathFilter: () => searchFilter },
      },
      activeSessions: {
        list: { pathFilter: () => activeSessionsFilter },
      },
    };

    await invalidateAgentSessionQueries(queryClient, trpc);

    // The four exact paths must be invalidated — no fake or synthesized
    // query keys may appear in the recorded call list.
    expect(invalidateQueries).toHaveBeenCalledTimes(4);
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, listFilter);
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, recentRepositoriesFilter);
    expect(invalidateQueries).toHaveBeenNthCalledWith(3, searchFilter);
    expect(invalidateQueries).toHaveBeenNthCalledWith(4, activeSessionsFilter);
  });
});
