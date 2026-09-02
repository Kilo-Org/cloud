import { afterEach, describe, expect, it, vi } from 'vitest';

import { getActiveSessionsQueryMetadata } from '@/lib/query-client';

import {
  ActiveSessionsLiveSync,
  makeCached,
  makeConnection,
  makeFakeQueryClient,
  makeQueryFn,
  QUERY_KEY,
  setupTimers,
  type SystemEvent,
} from '@/lib/active-sessions-live-sync.test-helpers';
import { refreshActiveSessionsNow } from '@/lib/active-sessions-live-sync';

setupTimers();

let sync: ActiveSessionsLiveSync | null = null;

afterEach(() => {
  if (sync) {
    sync.detach();
    sync = null;
  }
});

describe('ActiveSessionsLiveSync — manual refresh', () => {
  it('recovers a tray wedged by a missed reconnect signal', async () => {
    const conn = makeConnection();
    conn.__setConnected(true);
    const qc = makeFakeQueryClient({ sessions: [] });
    const queryFn = makeQueryFn();
    sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();

    const pending = refreshActiveSessionsNow(QUERY_KEY);
    await sync.getFetchQueue();
    expect(qc.__hasPendingFetch()).toBe(true);
    expect(qc.fetchQueryCalls).toBe(1);

    qc.__triggerFetchResolve({ sessions: [makeCached({ createdOnPlatform: 'cli' })] });
    const result = await pending;
    expect(result).toEqual({ accepted: true });
    expect(qc.__getCached()?.sessions[0]?.id).toBe('a1');
  });

  it('does not resolve before the forced fetch settles', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();

    let settled = false;
    const pending = refreshActiveSessionsNow(QUERY_KEY);
    // eslint-disable-next-line promise/prefer-await-to-then, promise/always-return
    void pending.then(() => {
      settled = true;
    });

    await sync.getFetchQueue();
    expect(qc.__hasPendingFetch()).toBe(true);
    expect(settled).toBe(false);

    qc.__triggerFetchResolve({ sessions: [] });
    await pending;
    expect(settled).toBe(true);
  });

  it('waits for an accepted replacement when cancellation fulfills with cached data', async () => {
    const conn = makeConnection();
    const cached = { sessions: [makeCached({ createdOnPlatform: 'cli' })] };
    const qc = makeFakeQueryClient(cached);
    const query = qc.getQueryCache().find({ queryKey: QUERY_KEY, exact: true });
    const before = getActiveSessionsQueryMetadata(query);
    sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    sync.attach();

    let settled = false;
    const fetchSpy = vi.spyOn(qc, 'fetchQuery');
    const pending = (async () => {
      const result = await refreshActiveSessionsNow(QUERY_KEY);
      settled = true;
      return result;
    })();
    await sync.getFetchQueue();
    const canceledFetch = fetchSpy.mock.results[0]?.value;
    conn.__fireSystem({ event: 'cli.disconnected', data: { connectionId: 'c1' } });
    await sync.getWriteQueue();
    await sync.getFetchQueue();

    expect(await canceledFetch).toEqual(cached);
    expect(getActiveSessionsQueryMetadata(query)).toBe(before);
    expect(qc.__getCached()?.sessions).toEqual([]);
    expect(sync.getPendingReasons()).toContain('manual');
    expect(qc.__hasPendingFetch()).toBe(true);
    expect(settled).toBe(false);

    qc.__triggerFetchResolve(cached);
    expect(await pending).toEqual({ accepted: true });
    expect(getActiveSessionsQueryMetadata(query).acceptedRevision).toBe(
      before.acceptedRevision + 1
    );
    expect(sync.getPendingReasons()).toEqual(new Set());
    expect(settled).toBe(true);
    expect(qc.__getCached()).toEqual(cached);
  });

  it('refetches after a failed refresh left a reason pending', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();

    // Build the D1 stuck state: a cli.disconnected refresh fails and is not re-kicked.
    const disconnected: SystemEvent = {
      event: 'cli.disconnected',
      data: { connectionId: 'c1' },
    };
    conn.__fireSystem(disconnected);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    qc.__triggerFetchReject(new Error('offline'));
    await sync.getFetchCompletion();

    // Owner is stuck with a pending reason and no in-flight fetch.
    expect(sync.getPendingReasons().has('cli-disconnected')).toBe(true);
    expect(qc.__hasPendingFetch()).toBe(false);

    // Manual refresh kicks a new fetch that clears the stuck reason.
    const previousCalls = qc.fetchQueryCalls;
    const pending = refreshActiveSessionsNow(QUERY_KEY);
    await sync.getFetchQueue();
    expect(qc.fetchQueryCalls).toBe(previousCalls + 1);
    expect(qc.__hasPendingFetch()).toBe(true);

    qc.__triggerFetchResolve({ sessions: [makeCached({ createdOnPlatform: 'cli' })] });
    const result = await pending;
    expect(result).toEqual({ accepted: true });
    expect(qc.__getCached()?.sessions[0]?.id).toBe('a1');
  });

  it('returns false and fetches nothing when no owner is attached', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    sync.detach();

    const prevCalls = qc.fetchQueryCalls;
    const result = await refreshActiveSessionsNow(QUERY_KEY);
    expect(result).toBe(false);
    expect(qc.fetchQueryCalls).toBe(prevCalls);
  });
});
