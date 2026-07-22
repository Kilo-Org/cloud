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

setupTimers();

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
