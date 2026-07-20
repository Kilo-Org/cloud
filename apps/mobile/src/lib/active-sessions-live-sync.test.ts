import { describe, expect, it, vi } from 'vitest';

import {
  ActiveSessionsLiveSync,
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

describe('ActiveSessionsLiveSync — attach / detach', () => {
  it('retains the connection on attach and releases on detach', () => {
    const release = vi.fn();
    const conn = makeConnection({ retain: vi.fn(() => release) });
    const qc = makeFakeQueryClient();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    const detach = sync.attach();
    expect(conn.retain).toHaveBeenCalledTimes(1);
    expect(conn.onSystemEvent).toHaveBeenCalledTimes(1);
    expect(conn.onConnectionChange).toHaveBeenCalledTimes(1);
    detach();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not publish a queued write after detach', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    sync.attach();
    const blockedWrite = deferred<undefined>();
    vi.mocked(qc.cancelQueries).mockImplementationOnce(async () => {
      await blockedWrite.promise;
    });
    conn.__fireSystem({
      event: 'sessions.list',
      data: { sessions: [{ id: 'first', status: 'running', title: 'First' }] },
    });
    conn.__fireSystem({
      event: 'sessions.list',
      data: { sessions: [{ id: 'queued', status: 'running', title: 'Queued' }] },
    });
    sync.detach();
    blockedWrite.resolve(undefined);
    await sync.getWriteQueue();
    expect(qc.setQueryData).not.toHaveBeenCalled();
  });

  it('keeps queued work fenced after detach and re-attach', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({
      sessions: [
        makeCached({
          id: 'current',
          connectionId: 'c2',
          createdAt: '2026-07-20T00:00:00.000Z',
        }),
      ],
    });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    const detach = sync.attach();
    const blockedWrite = deferred<undefined>();
    vi.mocked(qc.cancelQueries).mockImplementationOnce(async () => {
      await blockedWrite.promise;
    });
    conn.__fireSystem({
      event: 'sessions.list',
      data: {
        sessions: [
          {
            id: 'stale',
            status: 'running',
            title: 'Stale',
            connectionId: 'c1',
            createdAt: '2026-07-20T00:00:00.000Z',
          },
        ],
      },
    });
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });
    expect(qc.cancelQueries).toHaveBeenCalledTimes(1);

    detach();
    sync.attach();
    conn.__fireSystem({
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c2',
        sessions: [
          {
            id: 'current',
            status: 'running',
            title: 'Current',
          },
        ],
      },
    });
    blockedWrite.resolve(undefined);
    await sync.getWriteQueue();

    expect(qc.setQueryData).toHaveBeenCalledTimes(1);
    expect(qc.__getCached()?.sessions.map(session => session.id)).toEqual(['current']);
    expect(sync.getPendingReasons()).toEqual(new Set());
  });

  it('does not publish or re-kick an in-flight fetch after detach', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    sync.attach();
    sync.scheduleRefresh('reconnect');
    await sync.getFetchQueue();
    sync.scheduleRefresh('cli-connected');
    sync.detach();
    await sync.getFetchCompletion();
    await Promise.resolve();
    expect(sync.getPendingReasons()).toEqual(new Set());
    expect(qc.fetchQueryCalls).toBe(1);
    expect(qc.setQueryData).not.toHaveBeenCalled();
  });
});

describe('ActiveSessionsLiveSync — sessions.list', () => {
  it('replaces the cache with the snapshot (root filter applied)', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({ sessions: [makeCached({ id: 'old' })] });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    sync.attach();
    const event: SystemEvent = {
      event: 'sessions.list',
      data: {
        sessions: [
          { id: 'a', status: 'running', title: 'A', connectionId: 'c1' },
          {
            id: 'child',
            status: 'running',
            title: 'Child',
            connectionId: 'c1',
            parentSessionId: 'a',
          },
        ],
      },
    };
    conn.__fireSystem(event);
    await sync.getWriteQueue();
    expect(qc.__getCached()?.sessions.map(s => s.id)).toEqual(['a']);
  });
});

describe('ActiveSessionsLiveSync — sessions.heartbeat', () => {
  it('merges a heartbeat into the cache', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({ sessions: [makeCached({ id: 'x', connectionId: 'c2' })] });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    sync.attach();
    const event: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(event);
    await sync.getWriteQueue();
    expect(qc.__getCached()?.sessions.map(s => `${s.id}/${s.connectionId}`)).toEqual([
      'a/c1',
      'x/c2',
    ]);
  });

  it('a heartbeat that omits a previously-reported session drops it', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({
      sessions: [makeCached({ id: 'a' }), makeCached({ id: 'b' })],
    });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    sync.attach();
    const event: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(event);
    await sync.getWriteQueue();
    expect(qc.__getCached()?.sessions.map(s => s.id)).toEqual(['a']);
  });
});

describe('ActiveSessionsLiveSync — cli.disconnected', () => {
  it('drops the connection rows and schedules a refresh (queryFn actually invoked)', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({
      sessions: [
        makeCached({ id: 'a', connectionId: 'c1' }),
        makeCached({ id: 'b', connectionId: 'c2' }),
      ],
    });
    const queryFn = makeQueryFn({ sessions: [] });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    const event: SystemEvent = {
      event: 'cli.disconnected',
      data: { connectionId: 'c1' },
    };
    conn.__fireSystem(event);
    await sync.getWriteQueue();
    expect(qc.__getCached()?.sessions.map(s => s.id)).toEqual(['b']);
    await sync.getFetchQueue();
    expect(qc.__hasPendingFetch()).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});

describe('ActiveSessionsLiveSync — cli.connected', () => {
  it('schedules a refresh without a cache write', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({ sessions: [makeCached({ id: 'a' })] });
    const setQueryDataCalls = qc.setQueryData as ReturnType<typeof vi.fn>;
    setQueryDataCalls.mockClear();
    const queryFn = makeQueryFn();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    const event: SystemEvent = {
      event: 'cli.connected',
      data: { connectionId: 'c1' },
    };
    conn.__fireSystem(event);
    await sync.getFetchQueue();
    expect(setQueryDataCalls).not.toHaveBeenCalled();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed payload', async () => {
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
    const event: SystemEvent = { event: 'cli.connected', data: { connectionId: 42 } };
    conn.__fireSystem(event);
    await Promise.resolve();
    expect(sync.getPendingReasons()).toEqual(new Set());
    expect(queryFn).not.toHaveBeenCalled();
  });
});
