import { beforeEach, describe, expect, it } from 'bun:test';
import {
  childFromSessionCreated,
  eventKiloSessionId,
  permissionAskId,
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

  it('extracts permission.asked ids and ignores other events', () => {
    expect(permissionAskId({ type: 'permission.asked', properties: { id: 'perm_1' } })).toBe(
      'perm_1'
    );
    expect(permissionAskId({ type: 'permission.asked', properties: {} })).toBeUndefined();
    expect(
      permissionAskId({ type: 'message.updated', properties: { id: 'msg_1' } })
    ).toBeUndefined();
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

describe('session status snapshots', () => {
  it('reflects root busy and idle transitions in the existing snapshot array', () => {
    rememberAttachedRoot('root', '/ws');
    const sessions: HandlerSessionSnapshot[] = [];

    updateSessionSnapshots(
      { type: 'session.status', properties: { sessionID: 'root', status: { type: 'busy' } } },
      sessions
    );

    expect(sessions).toEqual([{ kiloSessionId: 'root', state: 'active', idleForMs: 0 }]);

    updateSessionSnapshots(
      { type: 'session.status', properties: { sessionID: 'root', status: { type: 'idle' } } },
      sessions
    );

    expect(sessions).toEqual([{ kiloSessionId: 'root', state: 'idle', idleForMs: 0 }]);
  });

  it.each(['retry', 'offline'])('treats root %s status as active', status => {
    rememberAttachedRoot('root', '/ws');
    const sessions: HandlerSessionSnapshot[] = [];

    updateSessionSnapshots(
      { type: 'session.status', properties: { sessionID: 'root', status: { type: status } } },
      sessions
    );

    expect(sessions).toEqual([{ kiloSessionId: 'root', state: 'active', idleForMs: 0 }]);
  });

  it('does not let child idle status override an active root', () => {
    rememberAttachedRoot('root', '/ws');
    rememberChildSession({ childId: 'child', parentId: 'root', directory: '/ws' });
    const sessions: HandlerSessionSnapshot[] = [];

    updateSessionSnapshots(
      { type: 'session.status', properties: { sessionID: 'root', status: { type: 'busy' } } },
      sessions
    );
    updateSessionSnapshots(
      {
        type: 'session.status',
        directory: '/ws',
        properties: { sessionID: 'child', status: { type: 'idle' } },
      },
      sessions
    );

    expect(sessions).toEqual([{ kiloSessionId: 'root', state: 'active', idleForMs: 0 }]);
  });

  it('ignores malformed, unknown, unattached, and unrelated events', () => {
    rememberAttachedRoot('root', '/ws');
    const sessions: HandlerSessionSnapshot[] = [
      { kiloSessionId: 'root', state: 'active', idleForMs: 0 },
    ];

    for (const event of [
      { type: 'session.status', properties: { sessionID: 'root' } },
      { type: 'session.status', properties: { sessionID: 'root', status: null } },
      { type: 'session.status', properties: { sessionID: 'root', status: { type: 'unknown' } } },
      { type: 'session.status', properties: { status: { type: 'idle' } } },
      { type: 'session.status', properties: { sessionID: 'other', status: { type: 'idle' } } },
      { type: 'session.idle', properties: { sessionID: 'root', status: { type: 'idle' } } },
    ]) {
      updateSessionSnapshots(event, sessions);
    }

    expect(sessions).toEqual([{ kiloSessionId: 'root', state: 'active', idleForMs: 0 }]);
  });

  it('tracks attached roots independently', () => {
    rememberAttachedRoot('root-a', '/a');
    rememberAttachedRoot('root-b', '/b');
    const sessions: HandlerSessionSnapshot[] = [];

    updateSessionSnapshots(
      { type: 'session.status', properties: { sessionID: 'root-a', status: { type: 'busy' } } },
      sessions
    );
    updateSessionSnapshots(
      { type: 'session.status', properties: { sessionID: 'root-b', status: { type: 'idle' } } },
      sessions
    );

    expect(sessions).toEqual([
      { kiloSessionId: 'root-a', state: 'active', idleForMs: 0 },
      { kiloSessionId: 'root-b', state: 'idle', idleForMs: 0 },
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

  it('uses a known directory root without inventing an event root', () => {
    rememberAttachedRoot('root', '/ws');

    expect(sessionEventIdentity({ sessionId: 'unknown', directory: '/ws' })).toEqual({
      directory: '/ws',
      kiloSessionId: 'unknown',
      rootKiloSessionId: 'root',
    });
  });

  it('returns no identity when neither session nor directory is known', () => {
    expect(sessionEventIdentity({ sessionId: 'unknown' })).toBeUndefined();
  });
});
