import type * as ReactQuery from '@tanstack/react-query';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mutationActiveTitle as activeTitle,
  deferred,
  flushQueryUpdates as flush,
  makeCached,
  makeTestQueryClient,
  QUERY_KEY,
  replaceMutationAccount,
  seedMutationSessions,
  mutationStoredTitles as titles,
} from '@/lib/active-sessions-live-sync.test-helpers';
import { isSignOutActive, setSignOutActive } from '@/lib/auth/sign-out-state';
import { setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';
import { getActiveSessionsQueryMetadata } from '@/lib/query-client';
import { useSessionMutations } from './use-session-mutations';

type Input = { session_id: string; title?: string };
type MutationOptions = ReactQuery.MutationOptions<unknown, Error, Input>;
let client = makeTestQueryClient();
const rpc = { rename: vi.fn(), delete: vi.fn() };
let renameMutationFn: MutationOptions['mutationFn'] = rpc.rename;
const messages: string[] = [];
const settled: (() => void)[] = [];
const listKey = [['cliSessionsV2', 'list'], { type: 'infinite' }] as const;
const activeFilter = { queryKey: [['activeSessions', 'list']] };

// Execute real mutations, including cancellation, context, and late rejection.
vi.mock('@tanstack/react-query', async importOriginal => {
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQueryClient: () => client,
    useMutation: (options: MutationOptions) => {
      const owner = client;
      return {
        mutateAsync: async (input: Input) => {
          const result = await owner.getMutationCache().build(owner, options).execute(input);
          return result;
        },
      };
    },
  };
});
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      list: { infiniteQueryKey: () => listKey },
      rename: {
        mutationOptions: (options: MutationOptions) => ({
          ...options,
          mutationFn: renameMutationFn,
        }),
      },
      delete: {
        mutationOptions: (options: MutationOptions) => ({ ...options, mutationFn: rpc.delete }),
      },
    },
    activeSessions: { list: { pathFilter: () => activeFilter } },
  }),
}));
vi.mock('@/lib/agent-session-cache', () => ({
  invalidateAgentSessionQueries: async (owner: ReactQuery.QueryClient) => {
    await owner.invalidateQueries();
  },
}));
vi.mock('@/lib/query/schedule-cache-maintenance', () => ({
  scheduleCacheMaintenance: (run: () => void) => {
    settled.push(run);
  },
}));
vi.mock('@/lib/a11y/announcing-toast', () => {
  const record = (message: string) => {
    messages.push(message);
  };
  return { announcingToast: { error: record, success: record } };
});

function expectAccountBUnchanged() {
  expect(titles(client, listKey)).toEqual(['Account B', 'Other']);
  expect(activeTitle(client)).toBe('Account B');
  expect(messages).toEqual([]);
  expect(client.getQueryState(listKey)?.isInvalidated).toBe(false);
  expect(isSignOutActive()).toBe(false);
}
afterAll(
  setTrpcUnauthorizedHandler(() => {
    setSignOutActive(true);
  })
);
beforeEach(() => {
  setSignOutActive(false);
  client = makeTestQueryClient();
  renameMutationFn = rpc.rename.mockReset().mockResolvedValue(undefined);
  rpc.delete.mockReset().mockResolvedValue(undefined);
  messages.length = 0;
  settled.length = 0;
  seedMutationSessions(client, listKey);
});
afterEach(() => {
  client.clear();
  setSignOutActive(false);
});

describe('useSessionMutations account publication', () => {
  it('rejects a missing rename mutation function and restores both caches', async () => {
    renameMutationFn = undefined;
    await expect(useSessionMutations().renameSessionAsync('s1', 'New')).rejects.toThrow();
    expect(titles(client, listKey)).toEqual(['Old', 'Other']);
    expect(activeTitle(client)).toBe('Old');
  });

  it('retitles and rolls back both caches without accepting manual writes or clearing a fetch failure', async () => {
    const query = client.getQueryCache().find({ queryKey: QUERY_KEY, exact: true });
    await client.fetchQuery({
      queryKey: QUERY_KEY,
      queryFn: () => ({ sessions: [makeCached({ id: 's1', title: 'Old' })] }),
    });
    await expect(
      client.fetchQuery({
        queryKey: QUERY_KEY,
        queryFn: () => {
          throw new Error('offline');
        },
      })
    ).rejects.toThrow('offline');
    const metadata = getActiveSessionsQueryMetadata(query);
    const request = deferred<undefined>();
    rpc.rename.mockReturnValue(request.promise);
    const error = new Error('rename failed');
    const rejection = expect(useSessionMutations().renameSessionAsync('s1', 'New')).rejects.toBe(
      error
    );
    await vi.waitFor(() => {
      expect(activeTitle(client)).toBe('New');
    });
    expect(titles(client, listKey)).toEqual(['New', 'Other']);
    expect(getActiveSessionsQueryMetadata(query)).toBe(metadata);
    request.reject(error);
    await rejection;
    expect(activeTitle(client)).toBe('Old');
    expect(titles(client, listKey)).toEqual(['Old', 'Other']);
    expect(getActiveSessionsQueryMetadata(query)).toBe(metadata);
    expect(messages).toEqual(['rename failed']);
    expect(rpc.rename.mock.calls[0]?.[0]).toEqual({ session_id: 's1', title: 'New' });
  });

  it('deletes only stored rows and moves focus after server confirmation', async () => {
    const request = deferred<undefined>();
    rpc.delete.mockReturnValue(request.promise);
    let focused = 'row';
    useSessionMutations().deleteSession('s1', () => {
      focused = 'list';
    });
    await vi.waitFor(() => {
      expect(titles(client, listKey)).toEqual(['Other']);
    });
    expect(activeTitle(client)).toBe('Old');
    expect(focused).toBe('row');
    request.resolve(undefined);
    await vi.waitFor(() => {
      expect(focused).toBe('list');
    });
    expect(messages).toEqual(['Session deleted']);
    expect(rpc.delete.mock.calls[0]?.[0]).toEqual({ session_id: 's1' });
  });

  it.each([
    { operation: 'rename', fails: true },
    { operation: 'delete', fails: true },
    { operation: 'rename', fails: false },
    { operation: 'delete', fails: false },
  ] as const)(
    'fences late $operation settlement, fails=$fails, after real clear and replacement',
    async ({ operation, fails }) => {
      const mutations = useSessionMutations();
      await mutations.renameSessionAsync('s1', 'Prepared');
      const request = deferred<undefined>();
      rpc[operation].mockReturnValue(request.promise);
      const outcomes: Promise<unknown>[] = [];
      let focused = 'account-b';
      if (operation === 'rename') {
        outcomes.push(
          expect(mutations.renameSessionAsync('s1', 'New')).rejects.toBeInstanceOf(Error)
        );
      } else {
        mutations.deleteSession('s1', () => {
          focused = 'stale-row';
        });
      }
      await vi.waitFor(() => {
        expect(titles(client, listKey)).not.toContain('Prepared');
      });
      replaceMutationAccount(client, listKey);
      for (const run of settled) {
        run();
      }
      if (fails) {
        request.reject(
          Object.assign(new Error('late unauthorized'), { data: { authRequired: true } })
        );
      } else {
        request.resolve(undefined);
      }
      await Promise.all(outcomes);
      await flush();
      expectAccountBUnchanged();
      expect(focused).toBe('account-b');
    }
  );

  it.each(['stored-rename', 'active-rename', 'stored-delete'] as const)(
    'rechecks the account after delayed %s cancellation',
    async stage => {
      const gate = deferred<undefined>();
      const cancel = client.cancelQueries.bind(client);
      const target = stage === 'active-rename' ? activeFilter.queryKey : listKey;
      let waiting = false;
      vi.spyOn(client, 'cancelQueries').mockImplementation(async filters => {
        if (JSON.stringify(filters?.queryKey) === JSON.stringify(target)) {
          waiting = true;
          await gate.promise;
        }
        await cancel(filters);
      });
      const mutations = useSessionMutations();
      if (stage === 'stored-delete') {
        mutations.deleteSession('s1');
      } else {
        mutations.renameSession('s1', 'New');
      }
      await vi.waitFor(() => {
        expect(waiting).toBe(true);
      });
      replaceMutationAccount(client, listKey);
      gate.resolve(undefined);
      await flush();
      expectAccountBUnchanged();
      expect(rpc.rename.mock.calls).toEqual([]);
      expect(rpc.delete.mock.calls).toEqual([]);
    }
  );

  it.each(['rename', 'delete'] as const)(
    'rejects queued %s work from the previous account',
    async queued => {
      const request = deferred<undefined>();
      rpc.rename.mockReturnValueOnce(request.promise);
      const mutations = useSessionMutations();
      mutations.renameSession('s1', 'New');
      if (queued === 'rename') {
        mutations.renameSession('s1', 'Later');
      } else {
        mutations.deleteSession('s1');
      }
      await vi.waitFor(() => {
        expect(activeTitle(client)).toBe('New');
      });
      replaceMutationAccount(client, listKey);
      request.resolve(undefined);
      await flush();
      expectAccountBUnchanged();
      expect(rpc.rename.mock.calls.map(call => call[0])).toEqual([
        { session_id: 's1', title: 'New' },
      ]);
      expect(rpc.delete.mock.calls).toEqual([]);
    }
  );

  it('does not send a mutation after replacement between onMutate and mutationFn', async () => {
    const unsubscribe = client.getMutationCache().subscribe(event => {
      if (
        event.type === 'updated' &&
        event.action.type === 'pending' &&
        event.mutation.state.context
      ) {
        replaceMutationAccount(client, listKey);
      }
    });
    await expect(useSessionMutations().renameSessionAsync('s1', 'New')).rejects.toThrow(
      'inactive account'
    );
    unsubscribe();
    expectAccountBUnchanged();
    expect(rpc.rename.mock.calls).toEqual([]);
  });

  it('keeps the latest same-account mutation generation in control of rollback', async () => {
    const deletion = deferred<undefined>();
    const rename = deferred<undefined>();
    rpc.delete.mockReturnValue(deletion.promise);
    rpc.rename.mockReturnValue(rename.promise);
    const mutations = useSessionMutations();
    mutations.deleteSession('s1');
    await vi.waitFor(() => {
      expect(titles(client, listKey)).toEqual(['Other']);
    });
    const error = new Error('rename failed');
    const rejection = expect(mutations.renameSessionAsync('s2', 'Newer')).rejects.toBe(error);
    await vi.waitFor(() => {
      expect(titles(client, listKey)).toEqual(['Newer']);
    });
    deletion.reject(new Error('delete failed'));
    await flush();
    expect(titles(client, listKey)).toEqual(['Newer']);
    rename.reject(error);
    await rejection;
    expect(titles(client, listKey)).toEqual(['Other']);
    expect(messages).toEqual(['delete failed', 'rename failed']);
  });
});
