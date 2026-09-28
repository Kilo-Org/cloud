import { afterEach, describe, expect, it } from 'vitest';

import { getActiveSessionsQueryMetadata } from '@/lib/query-client';

import {
  ActiveSessionsLiveSync,
  makeCached,
  makeConnection,
  makeFakeQueryClient,
  makeQueryFn,
  QUERY_KEY,
  setupTimers,
} from '@/lib/active-sessions-live-sync.test-helpers';

setupTimers();

let sync: ActiveSessionsLiveSync | null = null;

afterEach(() => {
  sync?.detach();
  sync = null;
});

function attach(
  qc: ReturnType<typeof makeFakeQueryClient>,
  queryFn: ReturnType<typeof makeQueryFn>
) {
  sync = new ActiveSessionsLiveSync({
    connection: makeConnection(),
    queryClient: qc,
    queryKey: QUERY_KEY,
    queryFn,
  });
  sync.attach();
  return sync;
}

describe('ActiveSessionsLiveSync — foreground refresh', () => {
  it('issues exactly one fetch for one foreground schedule', async () => {
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    const owner = attach(qc, queryFn);

    owner.scheduleRefresh('foreground');
    await owner.getFetchQueue();
    expect(queryFn).toHaveBeenCalledTimes(1);

    qc.__triggerFetchResolve({ sessions: [] });
    await owner.getFetchCompletion();

    // A resolved foreground refresh clears its reason and never re-kicks a poll.
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(owner.getPendingReasons()).toEqual(new Set());
    const query = qc.getQueryCache().find({ queryKey: QUERY_KEY, exact: true });
    expect(getActiveSessionsQueryMetadata(query).acceptedRevision).toBe(1);
  });

  it('coalesces a foreground reason with a concurrent reconnect into one fetch', async () => {
    const qc = makeFakeQueryClient();
    const queryFn = makeQueryFn();
    const owner = attach(qc, queryFn);

    // Both land before the fetch starts, so the existing coalescing owns them.
    owner.scheduleRefresh('foreground');
    owner.scheduleRefresh('reconnect');
    await owner.getFetchQueue();
    expect(queryFn).toHaveBeenCalledTimes(1);

    qc.__triggerFetchResolve({ sessions: [] });
    await owner.getFetchCompletion();
    expect(owner.getPendingReasons()).toEqual(new Set());
  });

  it('keeps the previous counts until the foreground fetch resolves', async () => {
    const previous = { sessions: [makeCached({ id: 'old', status: 'running' })] };
    const next = { sessions: [makeCached({ id: 'new', status: 'idle' })] };
    const qc = makeFakeQueryClient(previous);
    const queryFn = makeQueryFn(next);
    const owner = attach(qc, queryFn);

    owner.scheduleRefresh('foreground');
    await owner.getFetchQueue();

    // The surface must not blank or jump while the refresh is in flight.
    expect(qc.__getCached()).toEqual(previous);

    qc.__triggerFetchResolve(next);
    await owner.getFetchCompletion();

    expect(qc.__getCached()).toEqual(next);
  });
});
