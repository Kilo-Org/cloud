import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { isCancelledError, QueryClient, type QueryKey } from '@tanstack/react-query';
import { createTRPCClient } from '@trpc/client';
import type { inferRouterOutputs } from '@trpc/server';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { createStore } from 'jotai/vanilla';
import type { RootRouter } from '@/routers/root-router';
import { apiSessionToDbSession, dbSessionsAtom } from './store/db-session-atoms';
import { invalidateSessionQueries, removeDeletedSession } from './session-deletion';

type ApiSession = inferRouterOutputs<RootRouter>['cliSessionsV2']['list']['cliSessions'][number];

function makeSession(session_id: string): ApiSession {
  return {
    session_id,
    title: session_id,
    cloud_agent_session_id: null,
    cloud_agent_worktree_id: null,
    created_on_platform: 'cloud-agent',
    organization_id: null,
    git_url: null,
    git_branch: null,
    parent_session_id: null,
    created_at: '2026-08-26T12:00:00.000Z',
    updated_at: '2026-08-26T12:00:00.000Z',
    version: 2,
    status: 'busy',
    status_updated_at: null,
    associatedPr: null,
    total_cost_microdollars: null,
  };
}

function createFixture() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const trpc = createTRPCOptionsProxy<RootRouter>({
    client: createTRPCClient<RootRouter>({ links: [] }),
    queryClient,
  });
  const store = createStore();
  const listKeys = [
    trpc.cliSessionsV2.list.queryKey({}),
    trpc.cliSessionsV2.list.queryKey({ createdOnPlatform: 'cli' }),
  ];
  const searchKeys = ['matching', 'other'].map(search_string =>
    trpc.cliSessionsV2.search.queryKey({ search_string })
  );
  const activeKey = trpc.activeSessions.list.queryKey();
  const recentKey = trpc.cliSessionsV2.recentRepositories.queryKey({
    updatedSince: '2026-08-01T00:00:00.000Z',
  });
  const worktreeDetailsKey = trpc.cliSessionsV2.worktreeDetails.queryKey({
    worktreeIds: ['worktree_12345678-1234-4234-9234-123456789abc'],
    organizationId: null,
  });
  const sessions = ['ses_a', 'ses_b', 'ses_c'].map(makeSession);
  const persisted = new Set(sessions.map(session => session.session_id));
  const seedSessions = (rows: ApiSession[]) => {
    store.set(dbSessionsAtom, rows.map(apiSessionToDbSession));
    for (const key of listKeys) {
      queryClient.setQueryData(key, { cliSessions: rows, nextCursor: 'next-page' });
    }
    for (const key of searchKeys) {
      queryClient.setQueryData(key, { results: rows, limit: 20, offset: 0, nextCursor: 20 });
    }
    queryClient.setQueryData(activeKey, {
      sessions: rows.map(session => ({
        id: session.session_id,
        title: session.title ?? '',
        status: 'busy',
        connectionId: 'connection',
      })),
    });
  };
  seedSessions(sessions);
  queryClient.setQueryData(recentKey, { repositories: [] });
  queryClient.setQueryData(worktreeDetailsKey, {
    worktrees: {
      'worktree_12345678-1234-4234-9234-123456789abc': {
        name: null,
        defaultTitle: sessions[0].title,
        prSession: null,
        sessions: sessions.map(session => ({
          sessionId: session.session_id,
          sessionStatus: session.status,
          sessionStatusUpdatedAt: session.status_updated_at,
        })),
      },
    },
  });
  queryClient.setQueryData(['unrelated'], { cliSessions: sessions });

  const context = {
    queryClient,
    trpc,
    setDbSessions: update => store.set(dbSessionsAtom, update),
    deleteSessionFromStore: async sessionId => {
      persisted.delete(sessionId);
    },
  } satisfies Omit<Parameters<typeof removeDeletedSession>[0], 'sessionId'>;
  return {
    context,
    store,
    sessions,
    persisted,
    listKeys,
    searchKeys,
    activeKey,
    recentKey,
    worktreeDetailsKey,
    seedSessions,
  };
}

let fixture: ReturnType<typeof createFixture>;

function expectCachedSessions(ids: string[]) {
  const {
    context: { queryClient },
    store,
    listKeys,
    searchKeys,
    activeKey,
  } = fixture;
  expect(store.get(dbSessionsAtom).map(session => session.session_id)).toEqual(ids);
  for (const key of listKeys) {
    expect(queryClient.getQueryData(key)?.cliSessions.map(session => session.session_id)).toEqual(
      ids
    );
  }
  for (const key of searchKeys) {
    expect(queryClient.getQueryData(key)?.results.map(session => session.session_id)).toEqual(ids);
  }
  expect(queryClient.getQueryData(activeKey)?.sessions.map(session => session.id)).toEqual(ids);
}

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.context.queryClient.clear();
  jest.restoreAllMocks();
});

describe('session deletion', () => {
  it('removes confirmed rows from all caches before persistence finishes, preserving metadata and unrelated data', async () => {
    const { context, persisted, listKeys, searchKeys } = fixture;
    const persistence = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const unrelated = context.queryClient.getQueryData(['unrelated']);
    const deletion = removeDeletedSession({
      ...context,
      sessionId: 'ses_a',
      deleteSessionFromStore: async sessionId => {
        started.resolve();
        await persistence.promise;
        persisted.delete(sessionId);
      },
    });
    await started.promise;

    expectCachedSessions(['ses_b', 'ses_c']);
    expect(persisted.has('ses_a')).toBe(true);
    for (const key of listKeys) {
      expect(context.queryClient.getQueryData(key)?.nextCursor).toBe('next-page');
    }
    for (const key of searchKeys) {
      expect(context.queryClient.getQueryData(key)).toMatchObject({
        limit: 20,
        offset: 0,
        nextCursor: 20,
      });
    }
    expect(context.queryClient.getQueryData(['unrelated'])).toBe(unrelated);

    persistence.resolve();
    await deletion;
    expect([...persisted]).toEqual(['ses_b', 'ses_c']);
  });

  it('cancels stale list, search and active-session responses so they cannot restore a deleted row', async () => {
    const { context, listKeys, searchKeys, activeKey } = fixture;
    const response = Promise.withResolvers<void>();
    const keys: QueryKey[] = [...listKeys, ...searchKeys, activeKey];
    const requests = keys.map(queryKey => {
      const staleData = context.queryClient.getQueryData(queryKey);
      return context.queryClient
        .fetchQuery({
          queryKey,
          queryFn: async () => {
            await response.promise;
            return staleData;
          },
        })
        .catch(error => {
          if (!isCancelledError(error)) throw error;
        });
    });

    await removeDeletedSession({ ...context, sessionId: 'ses_a' });
    response.resolve();
    await Promise.all(requests);

    expectCachedSessions(['ses_b', 'ses_c']);
  });

  it('keeps overlapping deletions independent without losing newer rows or live updates', async () => {
    const { context, sessions, seedSessions, store, persisted } = fixture;
    const deletions = Promise.all(
      ['ses_a', 'ses_b'].map(sessionId => removeDeletedSession({ ...context, sessionId }))
    );
    seedSessions([
      sessions[0],
      sessions[1],
      { ...sessions[2], title: 'New live title' },
      makeSession('ses_new'),
    ]);
    await deletions;

    expectCachedSessions(['ses_c', 'ses_new']);
    expect(store.get(dbSessionsAtom)[0].title).toBe('New live title');
    expect([...persisted]).toEqual(['ses_c']);
  });

  it('reconciles queries without rolling back current data or another successful deletion', async () => {
    const {
      context,
      sessions,
      seedSessions,
      listKeys,
      searchKeys,
      activeKey,
      recentKey,
      worktreeDetailsKey,
    } = fixture;
    await removeDeletedSession({ ...context, sessionId: 'ses_b' });
    seedSessions([
      { ...sessions[0], title: 'New live title' },
      sessions[2],
      makeSession('ses_new'),
    ]);
    const keys: QueryKey[] = [...listKeys, ...searchKeys, activeKey, recentKey, worktreeDetailsKey];
    const currentData = keys.map(key => context.queryClient.getQueryData(key));

    await invalidateSessionQueries(context);

    expectCachedSessions(['ses_a', 'ses_c', 'ses_new']);
    keys.forEach((key, index) => {
      expect(context.queryClient.getQueryData(key)).toBe(currentData[index]);
      expect(context.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    });
    expect(context.queryClient.getQueryState(['unrelated'])?.isInvalidated).toBe(false);
  });

  it('does not undo a confirmed deletion when local persistence fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      removeDeletedSession({
        ...fixture.context,
        sessionId: 'ses_a',
        deleteSessionFromStore: async () => {
          throw new Error('IndexedDB unavailable');
        },
      })
    ).resolves.toBeUndefined();

    expectCachedSessions(['ses_b', 'ses_c']);
    expect(fixture.persisted.has('ses_a')).toBe(true);
  });
});
