import { beforeEach, describe, expect, it } from 'bun:test';
import {
  childFromSessionCreated,
  eventKiloSessionId,
  sessionEventIdentity,
  unfilteredKiloEvents,
  updateSessionSnapshots,
} from './feed';
import type { HandlerSessionSnapshot } from './sandbox-control-handlers';
import {
  rememberAttachedRoot,
  rememberChildSession,
  resetSessionDirectoryState,
} from './session-directories';

beforeEach(() => {
  resetSessionDirectoryState();
});

describe('unfilteredKiloEvents', () => {
  it('yields events from every directory', async () => {
    const events = [];
    for await (const event of unfilteredKiloEvents([
      { directory: '/a', payload: { type: 'message.updated', properties: { id: 'a' } } },
      { directory: '/b', payload: { type: 'session.idle', properties: {} } },
    ])) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'message.updated', properties: { id: 'a' }, directory: '/a' },
      { type: 'session.idle', properties: {}, directory: '/b' },
    ]);
  });

  it('preserves human-required permissions and raw heartbeat events', async () => {
    const permission = {
      type: 'permission.asked',
      properties: {
        id: 'perm_1',
        sessionID: 'root',
        permission: 'skill-shell',
        metadata: { requiresHuman: true },
        patterns: ['*'],
        always: [],
      },
    };
    const events = [];
    for await (const event of unfilteredKiloEvents([
      { directory: '/ws', payload: permission },
      { payload: { type: 'server.heartbeat' } },
    ])) {
      events.push(event);
    }
    expect(events).toEqual([
      { ...permission, directory: '/ws' },
      { type: 'server.heartbeat', properties: {} },
    ]);
  });
});

describe('eventKiloSessionId', () => {
  it('resolves every supported event property location', () => {
    expect(eventKiloSessionId({ sessionID: 'session-id' })).toBe('session-id');
    expect(eventKiloSessionId({ sessionId: 'session-id-2' })).toBe('session-id-2');
    expect(eventKiloSessionId({ info: { sessionID: 'info-session' } })).toBe('info-session');
    expect(eventKiloSessionId({ info: { id: 'info-id' } })).toBe('info-id');
    expect(eventKiloSessionId({ part: { sessionID: 'part-session' } })).toBe('part-session');
  });
});

describe('session activity snapshots', () => {
  it('records observation time rather than caching a lease-renewing busy state', () => {
    rememberAttachedRoot('root', '/ws');
    const sessions: HandlerSessionSnapshot[] = [{ kiloSessionId: 'root', lastActivityAt: 0 }];
    updateSessionSnapshots(
      { type: 'session.status', properties: { sessionID: 'root', status: { type: 'busy' } } },
      sessions,
      1
    );
    expect(sessions).toEqual([{ kiloSessionId: 'root', lastActivityAt: 1 }]);
    updateSessionSnapshots(
      { type: 'session.status', properties: { sessionID: 'root', status: { type: 'idle' } } },
      sessions,
      2
    );
    expect(sessions).toEqual([{ kiloSessionId: 'root', lastActivityAt: 2 }]);
  });

  it.each(['retry', 'offline'])('records a root %s event without inventing owned work', status => {
    rememberAttachedRoot('root', '/ws');
    const sessions: HandlerSessionSnapshot[] = [{ kiloSessionId: 'root', lastActivityAt: 0 }];
    updateSessionSnapshots(
      { type: 'session.status', properties: { sessionID: 'root', status: { type: status } } },
      sessions,
      1
    );
    expect(sessions).toEqual([{ kiloSessionId: 'root', lastActivityAt: 1 }]);
  });

  it('tracks child questions and keeps them pending through child idle events', () => {
    rememberAttachedRoot('root', '/ws');
    rememberChildSession({ childId: 'child', parentId: 'root', directory: '/ws' });
    const sessions: HandlerSessionSnapshot[] = [{ kiloSessionId: 'root', lastActivityAt: 0 }];
    updateSessionSnapshots(
      { type: 'question.asked', properties: { sessionID: 'child', id: 'question_1' } },
      sessions,
      1
    );
    updateSessionSnapshots(
      { type: 'permission.asked', properties: { sessionID: 'root', id: 'permission_1' } },
      sessions,
      2
    );
    updateSessionSnapshots(
      { type: 'session.status', properties: { sessionID: 'child', status: { type: 'idle' } } },
      sessions,
      3
    );
    expect(sessions).toEqual([
      {
        kiloSessionId: 'root',
        lastActivityAt: 3,
        pendingInputs: new Set(['question_1', 'permission_1']),
      },
    ]);
    updateSessionSnapshots(
      { type: 'question.replied', properties: { sessionID: 'child', requestID: 'question_1' } },
      sessions,
      4
    );
    expect(sessions[0]?.pendingInputs).toEqual(new Set(['permission_1']));
    updateSessionSnapshots(
      { type: 'permission.replied', properties: { sessionID: 'root', requestID: 'permission_1' } },
      sessions,
      5
    );
    expect(sessions).toEqual([{ kiloSessionId: 'root', lastActivityAt: 5 }]);
  });

  it('does not invent snapshots from unattached or unrelated events', () => {
    rememberAttachedRoot('root', '/ws');
    const sessions: HandlerSessionSnapshot[] = [{ kiloSessionId: 'root', lastActivityAt: 0 }];
    for (const event of [
      { type: 'session.status', properties: { status: { type: 'busy' } } },
      { type: 'session.status', properties: { sessionID: 'other', status: { type: 'busy' } } },
      { type: 'server.heartbeat', properties: {} },
    ])
      updateSessionSnapshots(event, sessions, 1);
    expect(sessions).toEqual([{ kiloSessionId: 'root', lastActivityAt: 0 }]);
  });

  it('tracks attached roots independently', () => {
    rememberAttachedRoot('root-a', '/a');
    rememberAttachedRoot('root-b', '/b');
    const sessions: HandlerSessionSnapshot[] = [
      { kiloSessionId: 'root-a', lastActivityAt: 0 },
      { kiloSessionId: 'root-b', lastActivityAt: 0 },
    ];
    updateSessionSnapshots(
      { type: 'session.status', properties: { sessionID: 'root-a', status: { type: 'busy' } } },
      sessions,
      1
    );
    updateSessionSnapshots(
      { type: 'session.status', properties: { sessionID: 'root-b', status: { type: 'idle' } } },
      sessions,
      2
    );
    expect(sessions).toEqual([
      { kiloSessionId: 'root-a', lastActivityAt: 1 },
      { kiloSessionId: 'root-b', lastActivityAt: 2 },
    ]);
  });
});

describe('session event identity', () => {
  it('reads child lineage from session.created and stamps the attached root', () => {
    rememberAttachedRoot('root', '/ws');
    const child = childFromSessionCreated({
      info: { id: 'child', parentID: 'root', directory: '/ws' },
    });
    if (child) rememberChildSession(child);

    expect(sessionEventIdentity({ sessionId: 'child', directory: '/ws' })).toEqual({
      directory: '/ws',
      kiloSessionId: 'child',
      rootKiloSessionId: 'root',
    });
  });

  it('reads session.created metadata', () => {
    expect(
      childFromSessionCreated({ info: { id: 'child', parentID: 'root', directory: '/ws' } })
    ).toEqual({ childId: 'child', parentId: 'root', directory: '/ws' });
    expect(childFromSessionCreated({ info: {} })).toBeUndefined();
  });

  it('stamps a root event with itself as the root', () => {
    rememberAttachedRoot('root', '/ws');

    expect(sessionEventIdentity({ sessionId: 'root' })).toEqual({
      directory: '/ws',
      kiloSessionId: 'root',
      rootKiloSessionId: 'root',
    });
  });

  it('does not attribute an unknown session to another root in the same directory', () => {
    rememberAttachedRoot('root', '/ws');

    expect(sessionEventIdentity({ sessionId: 'unknown', directory: '/ws' })).toEqual({
      directory: '/ws',
      kiloSessionId: 'unknown',
    });
  });

  it('keeps same-worktree root and child events distinct without guessing a directory-only owner', () => {
    rememberAttachedRoot('first', '/ws');
    rememberAttachedRoot('second', '/ws');
    const root = childFromSessionCreated({ info: { id: 'first', directory: '/ws' } });
    expect(root).toBeUndefined();
    if (root) rememberChildSession(root);
    const child = childFromSessionCreated({ info: { id: 'child', parentID: 'first' } });
    if (child) rememberChildSession(child);

    expect(sessionEventIdentity({ sessionId: 'first', directory: '/ws' })).toEqual({
      directory: '/ws',
      kiloSessionId: 'first',
      rootKiloSessionId: 'first',
    });
    expect(sessionEventIdentity({ sessionId: 'second', directory: '/ws' })).toEqual({
      directory: '/ws',
      kiloSessionId: 'second',
      rootKiloSessionId: 'second',
    });
    expect(sessionEventIdentity({ sessionId: 'child' })).toEqual({
      directory: '/ws',
      kiloSessionId: 'child',
      rootKiloSessionId: 'first',
    });
    expect(sessionEventIdentity({ directory: '/ws' })).toEqual({ directory: '/ws' });
  });

  it('returns no identity when neither session nor directory is known', () => {
    expect(sessionEventIdentity({ sessionId: 'unknown' })).toBeUndefined();
  });
});
