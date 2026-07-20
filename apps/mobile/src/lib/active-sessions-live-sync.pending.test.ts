import { describe, expect, it } from 'vitest';

import {
  ActiveSessionsLiveSync,
  makeCached,
  makeConnection,
  makeFakeQueryClient,
  makeQueryFn,
  QUERY_KEY,
  setupNow,
  setupTimers,
  type SystemEvent,
} from '@/lib/active-sessions-live-sync.test-helpers';

setupTimers();

describe('ActiveSessionsLiveSync — pending-reason semantics', () => {
  it('enrichment clears only when its own fetch completes', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    sync.scheduleRefresh('enrichment');
    await sync.getFetchQueue();
    expect(qc.__hasPendingFetch()).toBe(true);
    qc.__triggerFetchResolve({ sessions: [] });
    await sync.getFetchCompletion();
    expect(sync.getPendingReasons().has('enrichment')).toBe(false);
  });

  it('cli-disconnected survives cancellation by a heartbeat', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    const disconnected: SystemEvent = {
      event: 'cli.disconnected',
      data: { connectionId: 'c1' },
    };
    conn.__fireSystem(disconnected);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    expect(qc.__hasPendingFetch()).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(1);
    // A heartbeat arrives → cancelQueries cancels the in-flight fetch.
    const heartbeat: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c2',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    // The fetch was canceled; cli-disconnected's reason is still
    // pending and a fresh fetch was kicked.
    expect(sync.getPendingReasons().has('cli-disconnected')).toBe(true);
    expect(qc.__hasPendingFetch()).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(2);
    // Resolve it; the reason clears.
    qc.__triggerFetchResolve({ sessions: [] });
    await sync.getFetchCompletion();
    expect(sync.getPendingReasons().has('cli-disconnected')).toBe(false);
  });

  it('a fetch that errors does not clear its reason (transient failure)', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    sync.scheduleRefresh('cli-connected');
    await sync.getFetchQueue();
    expect(qc.__hasPendingFetch()).toBe(true);
    qc.__triggerFetchReject(new Error('network down'));
    await sync.getFetchCompletion();
    // The reason stays pending for the next scheduled trigger to retry.
    expect(sync.getPendingReasons().has('cli-connected')).toBe(true);
    // Genuine failures must NOT tight-loop; only a cancellation or a new
    // reason can trigger an immediate re-kick.
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('does not immediately retry a failed enrichment queued by a successful fetch', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    const { now, advance } = setupNow();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
      now,
    });
    sync.attach();

    sync.scheduleRefresh('cli-connected');
    await sync.getFetchQueue();
    qc.__triggerFetchResolve({ sessions: [makeCached({ id: 'a' })] });
    await sync.getFetchCompletion();
    await sync.getFetchQueue();

    expect(sync.getPendingReasons()).toEqual(new Set(['enrichment']));
    expect(queryFn).toHaveBeenCalledTimes(2);

    qc.__triggerFetchReject(new Error('network down'));
    await sync.getFetchCompletion();
    await Promise.resolve();
    await Promise.resolve();
    expect(queryFn).toHaveBeenCalledTimes(2);

    advance(10_001);
    const heartbeat: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  it('does not schedule enrichment after a fully enriched cli-connected fetch', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();

    sync.scheduleRefresh('cli-connected');
    await sync.getFetchQueue();
    qc.__triggerFetchResolve({
      sessions: [makeCached({ id: 'a', createdOnPlatform: 'cli' })],
    });
    await sync.getFetchCompletion();

    expect(sync.getPendingReasons()).toEqual(new Set());
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('a genuine fetch failure does not trigger an immediate retry (no tight loop)', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    sync.scheduleRefresh('reconnect');
    await sync.getFetchQueue();
    expect(qc.__hasPendingFetch()).toBe(true);
    // Genuine failure (not a cancellation by newer work).
    qc.__triggerFetchReject(new Error('network down'));
    await sync.getFetchCompletion();
    expect(sync.getPendingReasons().has('reconnect')).toBe(true);
    // No immediate re-fetch on genuine failure.
    expect(queryFn).toHaveBeenCalledTimes(1);
    // A later scheduled trigger retries the still-pending reason.
    sync.scheduleRefresh('reconnect');
    await sync.getFetchQueue();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('reconnect survives a heartbeat-driven cancellation', async () => {
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
    expect(qc.__hasPendingFetch()).toBe(true);
    // Heartbeat cancels the reconnect fetch.
    const heartbeat: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    expect(sync.getPendingReasons().has('reconnect')).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(2);
    qc.__triggerFetchResolve({ sessions: [] });
    await sync.getFetchCompletion();
    expect(sync.getPendingReasons().has('reconnect')).toBe(false);
  });
});
