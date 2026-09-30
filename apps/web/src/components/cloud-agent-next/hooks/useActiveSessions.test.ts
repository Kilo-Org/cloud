import {
  applyActiveSessionsHeartbeat,
  applyActiveSessionsList,
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

  it('drops cached rows the heartbeat no longer reports and appends new ones', () => {
    const sessions = applyActiveSessionsHeartbeat(
      [
        { id: 'root-1', status: 'idle', title: 'Ended', connectionId: 'conn-1' },
        { id: 'root-2', status: 'busy', title: 'Other CLI', connectionId: 'conn-2' },
      ],
      {
        connectionId: 'conn-1',
        sessions: [{ id: 'root-3', status: 'busy', title: 'New', connectionId: 'conn-1' }],
      }
    );

    expect(sessions).toEqual([
      { id: 'root-2', status: 'busy', title: 'Other CLI', connectionId: 'conn-2' },
      { id: 'root-3', status: 'busy', title: 'New', connectionId: 'conn-1' },
    ]);
  });

  it('keeps every row where it was when connections heartbeat in turn', () => {
    const connA = [
      { id: 'a1', status: 'busy', title: 'A1', connectionId: 'conn-a' },
      { id: 'a2', status: 'busy', title: 'A2', connectionId: 'conn-a' },
    ];
    const connB = [
      { id: 'b1', status: 'busy', title: 'B1', connectionId: 'conn-b' },
      { id: 'b2', status: 'busy', title: 'B2', connectionId: 'conn-b' },
    ];
    const settled = [...connA, ...connB];

    const afterA = applyActiveSessionsHeartbeat(settled, {
      connectionId: 'conn-a',
      sessions: connA.map(session => ({ ...session, status: 'idle' })),
    });
    const afterB = applyActiveSessionsHeartbeat(afterA, {
      connectionId: 'conn-b',
      sessions: connB,
    });

    expect(afterA.map(session => session.id)).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(afterB.map(session => session.id)).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(afterB).toEqual([
      { id: 'a1', status: 'idle', title: 'A1', connectionId: 'conn-a' },
      { id: 'a2', status: 'idle', title: 'A2', connectionId: 'conn-a' },
      ...connB,
    ]);
  });

  it('keeps the cached title for a known id and takes every other field from the heartbeat', () => {
    const sessions = applyActiveSessionsHeartbeat(
      [
        {
          id: 'root-1',
          status: 'idle',
          title: 'DB title',
          connectionId: 'conn-1',
          createdOnPlatform: 'cli',
          lastActivityAt: '2026-09-30 10:00:00+00',
        },
        { id: 'root-2', status: 'busy', title: 'Other CLI', connectionId: 'conn-2' },
      ],
      {
        connectionId: 'conn-1',
        sessions: [
          {
            id: 'root-1',
            status: 'busy',
            title: 'Stale CLI title',
            connectionId: 'conn-1',
          },
        ],
      }
    );

    expect(sessions).toEqual([
      {
        id: 'root-1',
        status: 'busy',
        title: 'DB title',
        connectionId: 'conn-1',
        createdOnPlatform: 'cli',
        lastActivityAt: '2026-09-30 10:00:00+00',
      },
      { id: 'root-2', status: 'busy', title: 'Other CLI', connectionId: 'conn-2' },
    ]);
  });

  it('appends a brand-new session id after the rows already on screen', () => {
    const sessions = applyActiveSessionsHeartbeat(
      [{ id: 'root-2', status: 'busy', title: 'Other CLI', connectionId: 'conn-2' }],
      {
        connectionId: 'conn-1',
        sessions: [{ id: 'root-3', status: 'busy', title: 'CLI title', connectionId: 'conn-1' }],
      }
    );

    expect(sessions).toEqual([
      { id: 'root-2', status: 'busy', title: 'Other CLI', connectionId: 'conn-2' },
      { id: 'root-3', status: 'busy', title: 'CLI title', connectionId: 'conn-1' },
    ]);
  });

  it('keeps a row another connection takes over in place and without a duplicate', () => {
    const sessions = applyActiveSessionsHeartbeat(
      [
        { id: 'root-1', status: 'busy', title: 'Untouched', connectionId: 'conn-1' },
        { id: 'root-2', status: 'busy', title: 'Moved', connectionId: 'conn-1' },
        { id: 'root-3', status: 'busy', title: 'Stayed', connectionId: 'conn-2' },
      ],
      {
        connectionId: 'conn-2',
        sessions: [
          { id: 'root-2', status: 'busy', title: 'Moved', connectionId: 'conn-2' },
          { id: 'root-3', status: 'busy', title: 'Stayed', connectionId: 'conn-2' },
        ],
      }
    );

    expect(sessions).toEqual([
      { id: 'root-1', status: 'busy', title: 'Untouched', connectionId: 'conn-1' },
      { id: 'root-2', status: 'busy', title: 'Moved', connectionId: 'conn-2' },
      { id: 'root-3', status: 'busy', title: 'Stayed', connectionId: 'conn-2' },
    ]);
  });

  it('carries the cached enrichment through a full sessions.list snapshot', () => {
    const sessions = applyActiveSessionsList(
      [
        {
          id: 'root-1',
          status: 'idle',
          title: 'DB title',
          connectionId: 'conn-1',
          createdOnPlatform: 'cli',
        },
        { id: 'root-3', status: 'busy', title: 'Gone', connectionId: 'conn-1' },
      ],
      [{ id: 'root-1', status: 'busy', title: 'Stale CLI title', connectionId: 'conn-1' }]
    );

    expect(sessions).toEqual([
      {
        id: 'root-1',
        status: 'busy',
        title: 'DB title',
        connectionId: 'conn-1',
        createdOnPlatform: 'cli',
      },
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
