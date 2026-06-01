import {
  applyActiveSessionsHeartbeat,
  getRootSessionsFromHeartbeatPayload,
  getRootSessionsFromListPayload,
  removeActiveSessionsForConnection,
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

  it('replaces all cached rows owned by a connection on heartbeat', () => {
    const sessions = applyActiveSessionsHeartbeat(
      [
        { id: 'root-1', status: 'idle', title: 'Stale', connectionId: 'conn-1' },
        { id: 'root-2', status: 'busy', title: 'Other CLI', connectionId: 'conn-2' },
      ],
      {
        connectionId: 'conn-1',
        sessions: [{ id: 'root-3', status: 'busy', title: 'New', connectionId: 'conn-1' }],
      }
    );

    expect(sessions).toEqual([
      { id: 'root-3', status: 'busy', title: 'New', connectionId: 'conn-1' },
      { id: 'root-2', status: 'busy', title: 'Other CLI', connectionId: 'conn-2' },
    ]);
  });

  it('removes all cached rows for a disconnected connection', () => {
    const sessions = removeActiveSessionsForConnection(
      [
        { id: 'root-1', status: 'busy', title: 'Disconnected', connectionId: 'conn-1' },
        { id: 'root-2', status: 'busy', title: 'Connected', connectionId: 'conn-2' },
      ],
      'conn-1'
    );

    expect(sessions).toEqual([
      { id: 'root-2', status: 'busy', title: 'Connected', connectionId: 'conn-2' },
    ]);
  });
});
