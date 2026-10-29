import { describe, expect, it, vi } from 'vitest';

import {
  ActiveSessionsLiveSync,
  flushQueryUpdates,
  makeCached,
  makeConnection,
  makeFakeQueryClient,
  makeQueryFn,
  QUERY_KEY,
  setupTimers,
} from '@/lib/active-sessions-live-sync.test-helpers';
import { getActiveSessionsQueryMetadata } from '@/lib/query-client';

setupTimers();

const heartbeat = { event: 'sessions.heartbeat', data: { connectionId: 'c1', sessions: [] } };
/** An already-fetched row: enriched, so no enrichment refresh competes here. */
const enriched = makeCached({ id: 'a1', createdAt: '2026-07-20T00:00:00.000Z' });

function makeSync(
  qc: ReturnType<typeof makeFakeQueryClient>,
  queryFn: ReturnType<typeof makeQueryFn>
) {
  const connection = makeConnection();
  const sync = new ActiveSessionsLiveSync({
    connection,
    queryClient: qc,
    queryKey: QUERY_KEY,
    queryFn,
  });
  sync.attach();
  return { connection, sync };
}

describe('ActiveSessionsLiveSync — a scope with no server outcome yet', () => {
  it('replaces the attempt its own socket write canceled', async () => {
    const qc = makeFakeQueryClient({ sessions: [] });
    const { connection, sync } = makeSync(qc, makeQueryFn());
    // A socket-only cache never counts as a server result.
    expect(
      getActiveSessionsQueryMetadata(qc.getQueryCache().find({ queryKey: QUERY_KEY }))
    ).toEqual({ acceptedRevision: 0, terminalError: null });
    sync.scheduleRefresh('manual');
    await sync.getFetchQueue();
    expect(qc.__hasPendingFetch()).toBe(true);
    connection.__fireSystem(heartbeat as never);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    // The canceled attempt is replaced instead of leaving the scope unsettled.
    expect(qc.fetchQueryCalls).toBe(2);
    expect(qc.__hasPendingFetch()).toBe(true);
    qc.__triggerFetchResolve({ sessions: [enriched] });
    await sync.getFetchCompletion();
    expect(
      getActiveSessionsQueryMetadata(qc.getQueryCache().find({ queryKey: QUERY_KEY }))
        .acceptedRevision
    ).toBe(1);
    expect(sync.getPendingReasons()).toEqual(new Set());
    sync.detach();
  });

  it('does not add a request once the scope has an accepted result', async () => {
    const qc = makeFakeQueryClient({ sessions: [] });
    const { connection, sync } = makeSync(qc, makeQueryFn());
    sync.scheduleRefresh('manual');
    await sync.getFetchQueue();
    qc.__triggerFetchResolve({ sessions: [enriched] });
    await sync.getFetchCompletion();
    const calls = qc.fetchQueryCalls;
    connection.__fireSystem(heartbeat as never);
    await sync.getWriteQueue();
    expect(sync.getPendingReasons()).toEqual(new Set());
    expect(qc.fetchQueryCalls).toBe(calls);
    sync.detach();
  });

  it('does not add a request while the surface has a retryable failure', async () => {
    const qc = makeFakeQueryClient({ sessions: [] });
    // A retryable failure stays cached; a permission denial on an unobserved
    // query is dropped instead, which is a different recovery path.
    const failure = new Error('offline');
    const queryFn = vi.fn(() => Promise.reject(failure));
    const { connection, sync } = makeSync(qc, queryFn as never);
    sync.scheduleRefresh('manual');
    await sync.getFetchQueue();
    await sync.getFetchCompletion();
    expect(
      getActiveSessionsQueryMetadata(qc.getQueryCache().find({ queryKey: QUERY_KEY, exact: true }))
        .terminalError
    ).toEqual({ error: failure, kind: 'retryable' });
    const calls = qc.fetchQueryCalls;
    connection.__fireSystem(heartbeat as never);
    await sync.getWriteQueue();
    // The error card's Retry owns this scope; no background request competes.
    expect(sync.getPendingReasons().has('reconcile')).toBe(false);
    expect(qc.fetchQueryCalls).toBe(calls);
    sync.detach();
  });

  it('lets an attempt land after the cancel budget instead of restarting it forever', async () => {
    const qc = makeFakeQueryClient({ sessions: [] });
    const { connection, sync } = makeSync(qc, makeQueryFn());
    sync.scheduleRefresh('manual');
    await sync.getFetchQueue();
    // Two writes spend the budget the scope allows its own writes.
    const spend = async (): Promise<void> => {
      connection.__fireSystem(heartbeat as never);
      await sync.getWriteQueue();
      await sync.getFetchQueue();
    };
    await spend();
    await spend();
    const cancels = qc.cancelQueriesCalls;
    let writeApplied = false;
    connection.__fireSystem(heartbeat as never);
    const write = (async (): Promise<void> => {
      await sync.getWriteQueue();
      writeApplied = true;
    })();
    await flushQueryUpdates();
    // Waiting on the attempt, not canceling it a third time.
    expect(writeApplied).toBe(false);
    expect(qc.cancelQueriesCalls).toBe(cancels);
    qc.__triggerFetchResolve({ sessions: [enriched] });
    await write;
    // The landed attempt is the scope's outcome; the write applied on top of it.
    expect(
      getActiveSessionsQueryMetadata(qc.getQueryCache().find({ queryKey: QUERY_KEY, exact: true }))
        .acceptedRevision
    ).toBe(1);
    expect(qc.__getCached()).toEqual({ sessions: [] });
    expect(sync.getPendingReasons()).toEqual(new Set());
    sync.detach();
  });

  it('recovers a scope whose write landed during a cancel-only stall', async () => {
    const qc = makeFakeQueryClient({ sessions: [] });
    const queryFn = makeQueryFn();
    const { connection, sync } = makeSync(qc, queryFn);
    // A write before any attempt started: nothing to cancel, and the scope has
    // no outcome, so the replacement attempt is scheduled on its own.
    connection.__fireSystem(heartbeat as never);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    expect(qc.fetchQueryCalls).toBe(1);
    qc.__triggerFetchResolve({ sessions: [] });
    await sync.getFetchCompletion();
    expect(
      getActiveSessionsQueryMetadata(qc.getQueryCache().find({ queryKey: QUERY_KEY }))
        .acceptedRevision
    ).toBe(1);
    sync.detach();
  });

  it('does not restore the reason for a scope whose load was never canceled', async () => {
    const qc = makeFakeQueryClient({ sessions: [] });
    const { sync } = makeSync(qc, makeQueryFn());
    sync.scheduleRefresh('manual');
    await sync.getFetchQueue();
    qc.__triggerFetchResolve({ sessions: [] });
    await sync.getFetchCompletion();
    expect(sync.getPendingReasons()).toEqual(new Set());
    expect(qc.fetchQueryCalls).toBe(1);
    sync.detach();
  });
});
