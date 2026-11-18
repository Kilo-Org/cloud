import { describe, expect, it, vi } from 'vitest';

import {
  ActiveSessionsLiveSync,
  type CachedActiveSessionsData,
  deferred,
  makeCached,
  makeConnection,
  makeFakeQueryClient,
  makeQueryFn,
  QUERY_KEY,
  setupTimers,
  type SystemEvent,
} from '@/lib/active-sessions-live-sync.test-helpers';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { createKiloAppQueryClient, getActiveSessionsQueryMetadata } from '@/lib/query-client';

setupTimers();

describe('ActiveSessionsLiveSync — publication fences', () => {
  it.each([
    { operation: 'write', accountChange: true },
    { operation: 'fetch', accountChange: true },
    { operation: 'write', accountChange: false },
    { operation: 'fetch', accountChange: false },
  ])(
    'fences queued $operation work after cancellation, accountChange=$accountChange',
    async ({ operation, accountChange }) => {
      const conn = makeConnection();
      const qc = makeFakeQueryClient();
      const sync = new ActiveSessionsLiveSync({
        connection: conn,
        queryClient: qc,
        queryKey: QUERY_KEY,
        queryFn: makeQueryFn(),
      });
      sync.attach();
      const gate = deferred<undefined>();
      const cancel = qc.cancelQueries.bind(qc);
      let waiting = false;
      vi.spyOn(qc, 'cancelQueries').mockImplementationOnce(async filters => {
        await cancel(filters);
        waiting = true;
        await gate.promise;
      });
      if (operation === 'write') {
        conn.__fireSystem({
          event: 'sessions.list',
          data: { sessions: [makeCached({ title: 'stale' })] },
        });
        conn.__fireSystem({ event: 'sessions.list', data: { sessions: [] } });
      } else {
        sync.scheduleRefresh('manual');
      }
      await vi.waitFor(() => {
        expect(waiting).toBe(true);
      });
      if (accountChange) {
        bumpAuthEpoch();
        qc.clear();
      } else {
        setSignOutActive(true);
      }
      const current = { sessions: [makeCached({ title: 'Current account' })] };
      qc.setQueryData(QUERY_KEY, current);
      try {
        gate.resolve(undefined);
        await sync.getWriteQueue();
        await sync.getFetchCompletion();
        expect(qc.__getCached()).toEqual(current);
        expect(qc.getQueryState(QUERY_KEY)?.fetchStatus).toBe('idle');
        expect(qc.__hasPendingFetch()).toBe(false);
      } finally {
        sync.detach();
        setSignOutActive(false);
      }
    }
  );

  it('rejects a server result after synchronous sign-out closes publication', async () => {
    const conn = makeConnection();
    const cached = { sessions: [makeCached({ title: 'Before sign-out' })] };
    const qc = createKiloAppQueryClient();
    qc.setQueryData(QUERY_KEY, cached);
    const query = qc.getQueryCache().find({ queryKey: QUERY_KEY, exact: true });
    const network = deferred<CachedActiveSessionsData>();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: async () => {
        const result = await network.promise;
        return result;
      },
    });
    sync.attach();
    const pending = sync.refreshNow(QUERY_KEY);
    await sync.getFetchQueue();
    setSignOutActive(true);
    try {
      network.resolve({ sessions: [makeCached({ title: 'Late result' })] });
      expect(await pending).toEqual({ accepted: false, canceled: true });
      expect(qc.getQueryData(QUERY_KEY)).toEqual(cached);
      expect(getActiveSessionsQueryMetadata(query).acceptedRevision).toBe(0);
    } finally {
      sync.detach();
      setSignOutActive(false);
    }
  });
});

describe('ActiveSessionsLiveSync — race tests', () => {
  it('heartbeat wins over an in-flight fetch (cache reflects heartbeat)', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({ sessions: [makeCached({ id: 'a' })] });
    const queryFn = makeQueryFn({
      sessions: [makeCached({ id: 'a', title: 'from-network' })],
    });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    // Start a refresh (e.g. reconnect) — fetch in flight.
    sync.scheduleRefresh('reconnect');
    await sync.getFetchQueue();
    expect(qc.__hasPendingFetch()).toBe(true);
    // Heartbeat arrives → cancelQueries cancels the in-flight fetch,
    // then setQueryData writes the heartbeat data.
    const heartbeat: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'from-heartbeat' }],
      },
    };
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    expect(qc.__getCached()?.sessions[0]?.title).toBe('from-heartbeat');
    // The original fetch was canceled; reconnect's reason is still
    // pending (canceled, not completed) — a fresh fetch was kicked.
    expect(sync.getPendingReasons().has('reconnect')).toBe(true);
  });

  it('removal vs late fetch: cli.disconnected wins, the late fetch is canceled', async () => {
    const conn = makeConnection();
    conn.__setConnected(false);
    const qc = makeFakeQueryClient();
    qc.__setCached({ sessions: [makeCached({ id: 'a', connectionId: 'c1' })] });
    const queryFn = makeQueryFn({
      // Late result would have re-added the row, but it must not win.
      sessions: [makeCached({ id: 'a', connectionId: 'c1', title: 'late' })],
    });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    // Reconnect triggers a fetch.
    conn.__fireConnection(true);
    await sync.getFetchQueue();
    expect(qc.__hasPendingFetch()).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(1);
    // cli.disconnected for c1 — write removes c1 rows + schedules refresh.
    const disconnected: SystemEvent = {
      event: 'cli.disconnected',
      data: { connectionId: 'c1' },
    };
    conn.__fireSystem(disconnected);
    await sync.getWriteQueue();
    // Wait for the replacement fetch to start before asserting it exists.
    await sync.getFetchQueue();
    // The write's cancelQueries canceled the original fetch; the
    // scheduled refresh started a new one. The cache no longer has
    // c1 rows.
    expect(qc.__getCached()?.sessions).toEqual([]);
    expect(qc.__hasPendingFetch()).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('stalled fetch never blocks a later WS write', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({ sessions: [] });
    // The queryFn returns a promise we never resolve. The cancelQueries
    // call inside the write pipeline must reject it.
    let stalled: ReturnType<typeof deferred<CachedActiveSessionsData>> | null = null;
    const queryFn = vi.fn(async () => {
      stalled = deferred<CachedActiveSessionsData>();
      const result = await stalled.promise;
      return result;
    });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    sync.scheduleRefresh('reconnect');
    await sync.getFetchQueue();
    expect(stalled).not.toBeNull();
    // A heartbeat arrives — its write must complete even though the
    // fetch is stalled.
    const heartbeat: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    expect(qc.__getCached()?.sessions[0]?.title).toBe('A');
  });
});
