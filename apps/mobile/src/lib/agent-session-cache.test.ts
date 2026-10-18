import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';

import { invalidateAgentSessionQueries } from './agent-session-cache';

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});

describe('session mutations refresh active search results', () => {
  it('removes a deleted session from each active searched list without changing an unrelated query', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const deleted = { session_id: 'deleted', title: 'Empty session fixture' };
    const remaining = { session_id: 'remaining', title: 'Other session' };
    const searchPrefix = ['cliSessionsV2', 'search'];
    const broadKey = [...searchPrefix, { account: 'primary', searchQuery: 'session' }];
    const narrowKey = [...searchPrefix, { account: 'primary', searchQuery: 'Empty' }];
    const unrelatedKey = ['unrelated', 'search'];
    client.setQueryData(broadKey, {
      pages: [{ results: [deleted, remaining] }],
      pageParams: [null],
    });
    client.setQueryData(narrowKey, { pages: [{ results: [deleted] }], pageParams: [null] });
    client.setQueryData(unrelatedKey, { results: [deleted] });
    const broad = new QueryObserver(client, {
      queryKey: broadKey,
      staleTime: Infinity,
      queryFn: () => ({ pages: [{ results: [remaining] }], pageParams: [null] }),
    });
    const narrow = new QueryObserver(client, {
      queryKey: narrowKey,
      staleTime: Infinity,
      queryFn: () => ({ pages: [{ results: [] }], pageParams: [null] }),
    });
    const stopBroad = broad.subscribe(() => undefined);
    const stopNarrow = narrow.subscribe(() => undefined);
    try {
      await invalidateAgentSessionQueries(client, {
        cliSessionsV2: {
          list: { pathFilter: () => ({ queryKey: ['cliSessionsV2', 'list'] }) },
          search: { pathFilter: () => ({ queryKey: searchPrefix }) },
          recentRepositories: {
            pathFilter: () => ({ queryKey: ['cliSessionsV2', 'recentRepositories'] }),
          },
        },
        activeSessions: { list: { pathFilter: () => ({ queryKey: ['activeSessions', 'list'] }) } },
      });
      expect(client.getQueryData(broadKey)).toEqual({
        pages: [{ results: [remaining] }],
        pageParams: [null],
      });
      expect(client.getQueryData(narrowKey)).toEqual({
        pages: [{ results: [] }],
        pageParams: [null],
      });
      expect(client.getQueryData(unrelatedKey)).toEqual({ results: [deleted] });
    } finally {
      stopBroad();
      stopNarrow();
    }
  });
});
