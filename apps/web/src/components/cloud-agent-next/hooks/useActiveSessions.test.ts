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

  it('drops the rows this connection no longer reports', () => {
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
      { id: 'root-3', status: 'busy', title: 'New', connectionId: 'conn-1' },
      { id: 'root-2', status: 'busy', title: 'Other CLI', connectionId: 'conn-2' },
    ]);
  });

  it('leaves rows of every other connection where they were', () => {
    const connB = [
      { id: 'b1', status: 'busy', title: 'B1', connectionId: 'conn-b' },
      { id: 'b2', status: 'busy', title: 'B2', connectionId: 'conn-b' },
    ];
    const sessions = applyActiveSessionsHeartbeat(
      [{ id: 'a1', status: 'busy', title: 'A1', connectionId: 'conn-a' }, ...connB],
      {
        connectionId: 'conn-a',
        sessions: [{ id: 'a1', status: 'idle', title: 'A1', connectionId: 'conn-a' }],
      }
    );

    expect(sessions).toEqual([
      { id: 'a1', status: 'idle', title: 'A1', connectionId: 'conn-a' },
      ...connB,
    ]);
  });

  it('keeps the cached enrichment the wire row does not carry', () => {
    const sessions = applyActiveSessionsHeartbeat(
      [
        {
          id: 'root-1',
          status: 'idle',
          title: 'DB title',
          connectionId: 'conn-1',
          createdOnPlatform: 'cli',
          organizationId: 'org-1',
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
        organizationId: 'org-1',
        lastActivityAt: '2026-09-30 10:00:00+00',
      },
      { id: 'root-2', status: 'busy', title: 'Other CLI', connectionId: 'conn-2' },
    ]);
  });

  it('keeps a personal organization scope, which is an explicit null', () => {
    const sessions = applyActiveSessionsHeartbeat(
      [
        {
          id: 'root-1',
          status: 'idle',
          title: 'Personal',
          connectionId: 'conn-1',
          organizationId: null,
        },
      ],
      {
        connectionId: 'conn-1',
        sessions: [{ id: 'root-1', status: 'busy', title: 'Stale', connectionId: 'conn-1' }],
      }
    );

    expect(sessions[0]?.organizationId).toBeNull();
  });

  it('takes a brand-new id from the wire as reported', () => {
    const sessions = applyActiveSessionsHeartbeat(
      [{ id: 'root-2', status: 'busy', title: 'Other CLI', connectionId: 'conn-2' }],
      {
        connectionId: 'conn-1',
        sessions: [{ id: 'root-3', status: 'busy', title: 'CLI title', connectionId: 'conn-1' }],
      }
    );

    expect(sessions).toEqual([
      { id: 'root-3', status: 'busy', title: 'CLI title', connectionId: 'conn-1' },
      { id: 'root-2', status: 'busy', title: 'Other CLI', connectionId: 'conn-2' },
    ]);
  });

  it('keeps another connection row a heartbeat of the aggregate omits', () => {
    const sessions = applyActiveSessionsHeartbeat(
      [
        { id: 'root-1', status: 'busy', title: 'Owned by conn-1', connectionId: 'conn-1' },
        { id: 'root-2', status: 'busy', title: 'Owned by conn-2', connectionId: 'conn-2' },
      ],
      {
        connectionId: 'conn-2',
        sessions: [
          { id: 'root-2', status: 'idle', title: 'Owned by conn-2', connectionId: 'conn-2' },
        ],
      }
    );

    expect(sessions).toEqual([
      { id: 'root-2', status: 'idle', title: 'Owned by conn-2', connectionId: 'conn-2' },
      { id: 'root-1', status: 'busy', title: 'Owned by conn-1', connectionId: 'conn-1' },
    ]);
  });

  it('attributes a cached live row from a later poll', () => {
    const afterHeartbeat = applyActiveSessionsHeartbeat([], {
      connectionId: 'conn-1',
      sessions: [{ id: 'root-1', status: 'busy', title: 'Fresh', connectionId: 'conn-1' }],
    });
    expect(afterHeartbeat[0]?.organizationId).toBeUndefined();

    const afterPoll = applyActiveSessionsList(afterHeartbeat, [
      {
        id: 'root-1',
        status: 'busy',
        title: 'Fresh',
        connectionId: 'conn-1',
        organizationId: 'org-1',
      },
    ]);

    expect(afterPoll).toEqual([
      {
        id: 'root-1',
        status: 'busy',
        title: 'Fresh',
        connectionId: 'conn-1',
        organizationId: 'org-1',
      },
    ]);
  });

  it('takes the polled scope over a stale cached one', () => {
    const sessions = applyActiveSessionsList(
      [
        {
          id: 'root-1',
          status: 'busy',
          title: 'Row',
          connectionId: 'conn-1',
          organizationId: 'org-1',
        },
      ],
      [{ id: 'root-1', status: 'busy', title: 'Row', connectionId: 'conn-1', organizationId: null }]
    );

    expect(sessions[0]?.organizationId).toBeNull();
  });

  it('renders a row another connection takes over once', () => {
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
      { id: 'root-2', status: 'busy', title: 'Moved', connectionId: 'conn-2' },
      { id: 'root-3', status: 'busy', title: 'Stayed', connectionId: 'conn-2' },
      { id: 'root-1', status: 'busy', title: 'Untouched', connectionId: 'conn-1' },
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
          organizationId: 'org-1',
        },
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
        organizationId: 'org-1',
      },
    ]);
  });

  it('keeps a cached row the snapshot omits', () => {
    const sessions = applyActiveSessionsList(
      [
        { id: 'root-1', status: 'idle', title: 'Listed', connectionId: 'conn-1' },
        {
          id: 'root-2',
          status: 'busy',
          title: 'Only on the socket',
          connectionId: 'conn-2',
          organizationId: 'org-1',
        },
      ],
      [{ id: 'root-1', status: 'busy', title: 'Stale CLI title', connectionId: 'conn-1' }]
    );

    expect(sessions).toEqual([
      { id: 'root-1', status: 'busy', title: 'Listed', connectionId: 'conn-1' },
      {
        id: 'root-2',
        status: 'busy',
        title: 'Only on the socket',
        connectionId: 'conn-2',
        organizationId: 'org-1',
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
