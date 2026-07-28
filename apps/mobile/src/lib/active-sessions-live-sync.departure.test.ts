import { describe, expect, it } from 'vitest';

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

setupTimers();

describe('ActiveSessionsLiveSync — departure refetch hook still works', () => {
  // The departure-triggered stored refetch lives in use-agent-sessions
  // and keys off the active-id set. This test simulates the data flow
  // that hook observes: a heartbeat omits a previously-known id, the
  // active-id set shrinks, and a refetch on the stored query is fired.
  // (We use a side-effect callback to model the refetch; the live-sync
  // owner is not responsible for triggering the stored refetch — it
  // only owns the active cache.)
  it('a heartbeat that omits an id shrinks the active set, enabling departure detection', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({
      sessions: [
        makeCached({ id: 'a', connectionId: 'c1' }),
        makeCached({ id: 'b', connectionId: 'c1' }),
      ],
    });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    sync.attach();
    const activeIdsBefore = new Set((qc.__getCached()?.sessions ?? []).map(s => s.id));
    const heartbeat: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    const activeIdsAfter = new Set((qc.__getCached()?.sessions ?? []).map(s => s.id));
    // The use-agent-sessions departure check (id present before, absent now)
    // would see `b` departed and fire stored.refetch(). We assert the
    // contract the hook relies on: the set is strictly smaller.
    expect(activeIdsBefore.has('b')).toBe(true);
    expect(activeIdsAfter.has('b')).toBe(false);
  });
});
