import {
  getRootSessionsFromHeartbeatPayload,
  getRootSessionsFromListPayload,
  mergeActiveSessionsWithPollingFallback,
} from './useActiveSessions';

describe('useActiveSessions live payload helpers', () => {
  it('filters child sessions out of sessions.list payloads', () => {
    const sessions = getRootSessionsFromListPayload({
      sessions: [
        { id: 'root-1', status: 'busy', title: 'Root', connectionId: 'conn-1' },
        {
          id: 'child-1',
          status: 'busy',
          title: 'Child',
          connectionId: 'conn-1',
          parentSessionId: 'root-1',
        },
      ],
    });

    expect(sessions).toEqual([
      { id: 'root-1', status: 'busy', title: 'Root', connectionId: 'conn-1' },
    ]);
  });

  it('adds connectionId and filters child sessions out of heartbeat payloads', () => {
    const payload = getRootSessionsFromHeartbeatPayload({
      connectionId: 'conn-1',
      sessions: [
        { id: 'root-1', status: 'busy', title: 'Root' },
        { id: 'child-1', status: 'busy', title: 'Child', parentSessionId: 'root-1' },
      ],
    });

    expect(payload).toEqual({
      connectionId: 'conn-1',
      sessions: [{ id: 'root-1', status: 'busy', title: 'Root', connectionId: 'conn-1' }],
    });
  });

  it('preserves empty owner heartbeat payloads so callers can remove stale rows', () => {
    const payload = getRootSessionsFromHeartbeatPayload({ connectionId: 'conn-1', sessions: [] });

    expect(payload).toEqual({ connectionId: 'conn-1', sessions: [] });
  });

  it('keeps polling results as a fallback after live sessions are initialized', () => {
    const sessions = mergeActiveSessionsWithPollingFallback(
      [{ id: 'root-1', status: 'busy', title: 'Live', connectionId: 'conn-1' }],
      [
        { id: 'root-1', status: 'idle', title: 'Polled stale', connectionId: 'conn-1' },
        { id: 'root-2', status: 'busy', title: 'Polled new', connectionId: 'conn-1' },
      ]
    );

    expect(sessions).toEqual([
      { id: 'root-1', status: 'busy', title: 'Live', connectionId: 'conn-1' },
      { id: 'root-2', status: 'busy', title: 'Polled new', connectionId: 'conn-1' },
    ]);
  });
});
