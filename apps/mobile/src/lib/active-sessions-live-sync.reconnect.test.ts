import { describe, expect, it, vi } from 'vitest';

import {
  ActiveSessionsLiveSync,
  makeConnection,
  makeFakeQueryClient,
  makeQueryFn,
  QUERY_KEY,
  setupTimers,
} from '@/lib/active-sessions-live-sync.test-helpers';

setupTimers();

describe('ActiveSessionsLiveSync — reconnect (onConnectionChange rising edge)', () => {
  it('triggers exactly one refresh per false → true transition', async () => {
    const conn = makeConnection();
    conn.__setConnected(false);
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    conn.__fireConnection(true);
    await sync.getFetchQueue();
    expect(queryFn).toHaveBeenCalledTimes(1);
    // Repeated true → still no new refresh.
    conn.__fireConnection(true);
    expect(queryFn).toHaveBeenCalledTimes(1);
    // false transition does not trigger.
    conn.__fireConnection(false);
    expect(queryFn).toHaveBeenCalledTimes(1);
    // Second rising edge → second refresh.
    conn.__fireConnection(true);
    await sync.getFetchQueue();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('release-then-retain still produces exactly one refresh per rising edge', async () => {
    // release-then-retain via re-attach: the plan covers the case where
    // a previous retain is fully released and a new retain starts the
    // connection back up. The rising-edge detector must not fire on
    // mount-with-already-connected state.
    const release = vi.fn();
    const retain = vi.fn(() => release);
    const conn = makeConnection({ retain });
    conn.__setConnected(false);
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    const detach1 = sync.attach();
    detach1();
    expect(release).toHaveBeenCalledTimes(1);
    // Re-attach while already connected → no initial refresh.
    conn.__setConnected(true);
    sync.attach();
    conn.__fireConnection(true);
    await sync.getFetchQueue();
    expect(queryFn).toHaveBeenCalledTimes(0);
    // Cycle: false → true (rising edge) → exactly one refresh.
    conn.__setConnected(false);
    conn.__fireConnection(false);
    conn.__fireConnection(true);
    await sync.getFetchQueue();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});

describe('ActiveSessionsLiveSync — scheduled fetch invokes the queryFn', () => {
  it('queryFn is invoked when scheduleRefresh runs', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn({ sessions: [] });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    sync.scheduleRefresh('reconnect');
    await sync.getFetchQueue();
    expect(queryFn).toHaveBeenCalledTimes(1);
    qc.__triggerFetchResolve({ sessions: [] });
    await sync.getFetchCompletion();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});
