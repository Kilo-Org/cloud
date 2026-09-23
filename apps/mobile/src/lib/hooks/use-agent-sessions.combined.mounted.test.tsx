/* eslint-disable max-lines -- DOM-free React Native hook integration; the combined/live refresh matrix exceeds the default line limit */
import { type AppStateStatus } from 'react-native';
import { act } from '@/test/renderer';
import { onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { ActiveSessionsLiveSync } from '@/lib/active-sessions-live-sync';
import {
  createQueryProbe,
  deferred,
  flushQueryUpdates as flush,
  makeActiveSessionsQueryKey,
  makeCached,
  makeConnection,
  makeTestQueryClient,
  QUERY_KEY,
} from '@/lib/active-sessions-live-sync.test-helpers';
import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive, setSignOutActive } from '@/lib/auth/sign-out-state';
import { useAgentSessions, useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';

const state = vi.hoisted(() => ({
  organizationId: null as string | null,
  refetchOnWindowFocus: undefined as boolean | undefined,
  active: vi.fn(),
  stored: vi.fn(),
  maintenance: [] as (() => void)[],
  // The shared `useAppLifecycle` store registers here; tests read the handler
  // back to fire a foreground edge.
  appStateAddEventListener: vi.fn((_event: string, _listener: (next: AppStateStatus) => void) => ({
    remove: vi.fn(),
  })),
  // Every stored-row set the mounted hook rendered, so a test can prove the
  // list never blanked across a page-one reset.
  storedTitles: [] as (string | null)[][],
}));
const STORED_KEY = [['cliSessionsV2', 'list'], { type: 'infinite' }] as const;
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({
    token: 'account',
    isLoading: false,
    isSigningOut: isSignOutActive(),
    authEpoch: currentAuthEpoch(),
  }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: state.organizationId, isLoaded: true }),
}));
vi.mock('@/lib/trpc', () => {
  const trpc = {
    activeSessions: {
      list: {
        queryKey: (input: unknown) => [['activeSessions', 'list'], { input, type: 'query' }],
        queryOptions: (input: unknown, options: object) => ({
          queryKey: [['activeSessions', 'list'], { input, type: 'query' }],
          queryFn: state.active,
          ...options,
        }),
      },
    },
    cliSessionsV2: {
      list: {
        infiniteQueryKey: () => STORED_KEY,
        pathFilter: () => ({ queryKey: [['cliSessionsV2', 'list']] }),
        infiniteQueryOptions: (_input: unknown, options: object) => ({
          queryKey: STORED_KEY,
          queryFn: state.stored,
          initialPageParam: null,
          ...options,
        }),
      },
    },
  };
  return { useTRPC: () => trpc };
});
vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionState: () => false,
}));
vi.mock('react-native', () => ({
  InteractionManager: {
    runAfterInteractions: (run: () => void) => {
      state.maintenance.push(run);
    },
  },
  AppState: { currentState: 'active', addEventListener: state.appStateAddEventListener },
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: vi.fn(),
}));

let client = makeTestQueryClient();
let latest: ReturnType<typeof useAgentSessions> | undefined = undefined;
let live: ReturnType<typeof useLiveAgentSessions> | undefined = undefined;
let owner: ActiveSessionsLiveSync | undefined = undefined;
function stored(title: string, sessionId = 'stored') {
  return {
    session_id: sessionId,
    title,
    created_at: '2026-08-28T00:00:00Z',
    updated_at: '2026-08-28T00:00:00Z',
  };
}
function history(title: string) {
  return { cliSessions: [stored(title)], nextCursor: null };
}
function Probe() {
  latest = useAgentSessions({
    organizationId: state.organizationId,
    refetchOnWindowFocus: state.refetchOnWindowFocus,
  });
  live = useLiveAgentSessions({ organizationId: state.organizationId });
  state.storedTitles.push(latest.storedSessions.map(row => row.title));
  return null;
}
const { render, unmount } = createQueryProbe(Probe, () => client);
/** The app-foreground listener the shared `useAppLifecycle` store registered. */
function latestAppStateListener(): (next: AppStateStatus) => void {
  const handler = state.appStateAddEventListener.mock.calls.at(-1)?.[1];
  if (!handler) {
    throw new Error('AppState listener was not registered');
  }
  return handler;
}
function combined() {
  if (!latest) {
    throw new Error('Missing combined hook');
  }
  return latest;
}
function attach(queryKey: readonly unknown[]) {
  owner = new ActiveSessionsLiveSync({
    connection: makeConnection(),
    queryClient: client,
    queryKey,
    queryFn: state.active,
  });
  owner.attach();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setSignOutActive(false);
  state.organizationId = null;
  state.refetchOnWindowFocus = undefined;
  state.maintenance.length = 0;
  state.storedTitles.length = 0;
  state.appStateAddEventListener.mockClear();
  state.active.mockReset().mockResolvedValue({
    sessions: [makeCached({ id: 'fresh', createdOnPlatform: 'cli', organizationId: null })],
  });
  state.stored.mockReset().mockResolvedValue(history('New history'));
  client = makeTestQueryClient();
  client.setQueryData(QUERY_KEY, { sessions: [makeCached({ organizationId: null })] });
  client.setQueryData(STORED_KEY, { pages: [history('Old history')], pageParams: [null] });
});
afterEach(async () => {
  await act(async () => {
    unmount();
    owner?.detach();
    client.clear();
    await flush();
  });
  owner = undefined;
  latest = undefined;
  live = undefined;
  setSignOutActive(false);
  onlineManager.setOnline(true);
});
async function refreshLive() {
  let accepted = false;
  await act(async () => {
    if (!live) {
      throw new Error('Missing live hook');
    }
    accepted = await live.refetch();
    await flush();
  });
  return accepted;
}

describe('combined and live refresh callers', () => {
  it('uses the live query fallback when an owner has another complete key', async () => {
    const otherKey = [
      ['activeSessions', 'list'],
      {
        input: { ...buildActiveSessionsTrayInput(null), includeCloudAgentSessions: false },
        type: 'query',
      },
    ];
    const other = { sessions: [makeCached({ id: 'other' })] };
    client.setQueryData(otherKey, other);
    // Start from a live set that was never populated: the socket-window hold
    // (useLiveSessionsHold) only keeps a prior non-empty set.
    client.setQueryData(QUERY_KEY, { sessions: [] });
    attach(otherKey);
    state.active.mockResolvedValue({ sessions: [] });
    await render();
    expect(await refreshLive()).toBe(true);
    expect(live?.activeSessions).toEqual([]);
    expect(client.getQueryData(otherKey)).toEqual(other);
  });

  it('exposes a paused active query so callers can treat liveness as unresolved', async () => {
    // Offline with no active rows: React Query pauses the live lookup, so it is
    // neither loading nor errored. The gate needs this flag to offer a retry
    // instead of a settled empty state.
    client.removeQueries({ queryKey: QUERY_KEY });
    onlineManager.setOnline(false);
    await render();
    expect(combined().activeIsPaused).toBe(true);
    expect(combined().activeIsError).toBe(false);
    expect(combined().activeSessions).toEqual([]);
  });

  it('uses the live fallback after a handled owner failure', async () => {
    attach(QUERY_KEY);
    await render();
    state.active.mockRejectedValue(new Error('offline'));
    expect(await refreshLive()).toBe(false);
    expect(state.active.mock.calls).toHaveLength(2);
    expect(owner?.getPendingReasons()).toContain('manual');
    expect(live?.terminalError?.kind).toBe('retryable');
    expect(live?.activeSessions.map(row => row.id)).toEqual(['a1']);
  });

  it.each(['matching', 'mismatched'] as const)(
    'waits for storedRefetch with a %s live owner',
    async scope => {
      const otherKey = makeActiveSessionsQueryKey('other-org');
      client.setQueryData(otherKey, { sessions: [makeCached({ id: 'other' })] });
      attach(scope === 'matching' ? QUERY_KEY : otherKey);
      await render();
      const storedRequest = deferred<ReturnType<typeof history>>();
      state.stored.mockReturnValueOnce(storedRequest.promise);
      let done = false;
      let pending: Promise<void> | undefined = undefined;
      await act(async () => {
        pending = (async () => {
          await combined().refetch();
          done = true;
        })();
        await flush();
      });
      expect(combined().activeSessions.map(row => row.id)).toEqual(['fresh']);
      expect(combined().storedSessions.map(row => row.title)).toEqual(['Old history']);
      expect(done).toBe(false);
      await act(async () => {
        storedRequest.resolve(history('New history'));
        await pending;
        await flush();
      });
      expect(done).toBe(true);
      expect(combined().storedSessions.map(row => row.title)).toEqual(['New history']);
      expect(client.getQueryData(otherKey)).toEqual({ sessions: [makeCached({ id: 'other' })] });
    }
  );

  it('keeps stored refetch behind an in-flight next page', async () => {
    client.setQueryData(STORED_KEY, {
      pages: [{ ...history('Old history'), nextCursor: 'next' }],
      pageParams: [null],
    });
    await render();
    const nextPage = deferred<ReturnType<typeof history>>();
    const firstPage = deferred<ReturnType<typeof history>>();
    state.stored.mockReturnValueOnce(nextPage.promise).mockReturnValueOnce(firstPage.promise);
    let page: Promise<void> | undefined = undefined;
    let refresh: Promise<void> | undefined = undefined;
    let finished = false;
    await act(async () => {
      page = combined().fetchNextPage();
      refresh = (async () => {
        await combined().refetch();
        finished = true;
      })();
      await flush();
    });
    expect(state.stored.mock.calls).toHaveLength(1);
    expect(finished).toBe(false);
    await act(async () => {
      nextPage.resolve({ cliSessions: [stored('Next page', 'next')], nextCursor: null });
      await page;
      await flush();
    });
    expect(state.stored.mock.calls).toHaveLength(2);
    // The queued refetch is a page-one reconcile, so it resets the cache as
    // soon as the next page settles. The list holds the rows it had already
    // painted (page two was never rendered before the reset) and refetches
    // page one from `initialPageParam`.
    expect(state.stored.mock.calls[1]?.[0]).toMatchObject({ pageParam: null });
    expect(combined().storedSessions.map(row => row.title)).toEqual(['Old history']);
    await act(async () => {
      firstPage.resolve(history('New history'));
      await refresh;
      await flush();
    });
    expect(combined().storedSessions.map(row => row.title)).toEqual(['New history']);
    expect(finished).toBe(true);
  });

  it.each(['context', 'account', 'sign-out', 'reattach'] as const)(
    'does not publish old refresh or departure work after %s changes',
    async change => {
      attach(QUERY_KEY);
      await render();
      const network = deferred<{ sessions: ReturnType<typeof makeCached>[] }>();
      state.active.mockReturnValue(network.promise);
      let pending: Promise<void> | undefined = undefined;
      await act(async () => {
        pending = combined().refetch();
        await flush();
      });
      if (change === 'account') {
        await act(async () => {
          client.setQueryData(QUERY_KEY, { sessions: [] });
          await flush();
        });
        expect(state.maintenance.length).toBeGreaterThan(0);
        bumpAuthEpoch();
        client.clear();
      }
      if (change === 'context') {
        state.organizationId = 'org-b';
      }
      if (change === 'sign-out') {
        setSignOutActive(true);
      }
      if (change === 'reattach') {
        owner?.detach();
        owner?.attach();
      }
      const key = makeActiveSessionsQueryKey(state.organizationId);
      client.setQueryData(key, {
        sessions: [makeCached({ id: 'b', organizationId: state.organizationId })],
      });
      const historyB = { pages: [history('Account B')], pageParams: [null] };
      client.setQueryData(STORED_KEY, historyB);
      await render();
      await act(async () => {
        network.resolve({ sessions: [] });
        await pending;
        for (const run of state.maintenance.splice(0)) {
          run();
        }
        await flush();
      });
      expect(combined().activeSessions.map(row => row.id)).toEqual(
        change === 'sign-out' ? [] : ['b']
      );
      if (change === 'account') {
        expect(client.getQueryData(STORED_KEY)).toEqual(historyB);
      }
    }
  );

  it('reconciles page one on the app-foreground edge without refetching retained pages', async () => {
    // Three retained pages: React Query's native focus refetch would re-request
    // all of them, the foreground reconcile must request only page one.
    client.setQueryData(STORED_KEY, {
      pages: [
        { cliSessions: [stored('Page one', 'p1')], nextCursor: 'c1' },
        { cliSessions: [stored('Page two', 'p2')], nextCursor: 'c2' },
        { cliSessions: [stored('Page three', 'p3')], nextCursor: null },
      ],
      pageParams: [null, 'c1', 'c2'],
    });
    await render();
    expect(combined().storedSessions.map(row => row.title)).toEqual([
      'Page one',
      'Page two',
      'Page three',
    ]);

    const listener = latestAppStateListener();
    await act(async () => {
      listener('background');
      await flush();
    });
    // Backgrounding alone is not a foreground edge: no reconcile.
    expect(state.stored.mock.calls).toHaveLength(0);

    state.stored.mockClear();
    const page = deferred<ReturnType<typeof history>>();
    state.stored.mockReturnValueOnce(page.promise);
    await act(async () => {
      listener('active');
      await flush();
    });

    // Exactly one `cliSessionsV2.list` request, from `initialPageParam`.
    expect(state.stored.mock.calls).toHaveLength(1);
    expect(state.stored.mock.calls[0]?.[0]).toMatchObject({ pageParam: null });
    // The cached pages were reset...
    expect(client.getQueryData(STORED_KEY)).toEqual({ pages: [], pageParams: [] });
    // ...but the rows already painted were held, never blanked, across the reset.
    expect(combined().storedSessions.map(row => row.title)).toEqual([
      'Page one',
      'Page two',
      'Page three',
    ]);
    expect(state.storedTitles.every(titles => titles.length > 0)).toBe(true);

    await act(async () => {
      page.resolve(history('Refreshed'));
      await flush();
    });
    expect(combined().storedSessions.map(row => row.title)).toEqual(['Refreshed']);
    expect(client.getQueryData(STORED_KEY)).toEqual({
      pages: [history('Refreshed')],
      pageParams: [null],
    });
  });

  it('does not reconcile on the foreground edge when the caller drives foreground itself', async () => {
    state.refetchOnWindowFocus = false;
    await render();
    const listener = latestAppStateListener();
    await act(async () => {
      listener('background');
      await flush();
    });
    state.stored.mockClear();
    await act(async () => {
      listener('active');
      await flush();
    });
    expect(state.stored.mock.calls).toHaveLength(0);
    expect(combined().storedSessions.map(row => row.title)).toEqual(['Old history']);
  });

  it('holds the painted rows when a foreground reconcile is paused offline', async () => {
    // The reconcile empties the cache before refetching page one. Offline the
    // refetch is paused, not fetching, so the hold must cover the unresolved
    // refetch too: the list has to keep the rows the user was reading instead
    // of blanking into its empty state until the network returns.
    client.setQueryData(STORED_KEY, {
      pages: [
        { cliSessions: [stored('Page one', 'p1')], nextCursor: 'c1' },
        { cliSessions: [stored('Page two', 'p2')], nextCursor: 'c2' },
        { cliSessions: [stored('Page three', 'p3')], nextCursor: null },
      ],
      pageParams: [null, 'c1', 'c2'],
    });
    await render();
    const listener = latestAppStateListener();
    await act(async () => {
      listener('background');
      await flush();
    });

    onlineManager.setOnline(false);
    state.stored.mockClear();
    await act(async () => {
      listener('active');
      await flush();
    });

    // No request ran: the page-one fetch is paused, not fetching.
    expect(state.stored.mock.calls).toHaveLength(0);
    expect(client.getQueryData(STORED_KEY)).toEqual({ pages: [], pageParams: [] });
    expect(combined().storedIsPaused).toBe(true);
    // The reset did not blank the list: the painted rows are still rendered.
    expect(combined().storedSessions.map(row => row.title)).toEqual([
      'Page one',
      'Page two',
      'Page three',
    ]);
    expect(state.storedTitles.every(titles => titles.length > 0)).toBe(true);

    // Recovering the network refetches page one and releases the hold.
    const page = deferred<ReturnType<typeof history>>();
    state.stored.mockReturnValueOnce(page.promise);
    await act(async () => {
      onlineManager.setOnline(true);
      await flush();
    });
    expect(combined().storedSessions.map(row => row.title)).toEqual([
      'Page one',
      'Page two',
      'Page three',
    ]);
    await act(async () => {
      page.resolve(history('Reconnected'));
      await flush();
    });
    expect(combined().storedSessions.map(row => row.title)).toEqual(['Reconnected']);
  });

  it('holds the painted rows when a foreground reconcile fails', async () => {
    // A failed page-one refetch leaves the cache empty and the query errored.
    // The hold must survive it so the screen can show the inline error over the
    // rows the user was reading instead of blanking into its full-screen error.
    client.setQueryData(STORED_KEY, {
      pages: [
        { cliSessions: [stored('Page one', 'p1')], nextCursor: 'c1' },
        { cliSessions: [stored('Page two', 'p2')], nextCursor: 'c2' },
        { cliSessions: [stored('Page three', 'p3')], nextCursor: null },
      ],
      pageParams: [null, 'c1', 'c2'],
    });
    await render();
    const listener = latestAppStateListener();
    await act(async () => {
      listener('background');
      await flush();
    });

    state.stored.mockClear();
    state.stored.mockRejectedValueOnce(new Error('network'));
    await act(async () => {
      listener('active');
      await flush();
    });

    expect(state.stored.mock.calls).toHaveLength(1);
    expect(combined().storedIsError).toBe(true);
    expect(combined().storedSessions.map(row => row.title)).toEqual([
      'Page one',
      'Page two',
      'Page three',
    ]);
    expect(state.storedTitles.every(titles => titles.length > 0)).toBe(true);
  });
});
