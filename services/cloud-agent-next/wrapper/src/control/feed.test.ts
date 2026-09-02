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
  directoryForSession,
  forgetAttachedRoot,
  rememberAttachedRoot,
  rememberChildSession,
  resetSessionDirectoryState,
  rootForSession,
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

  it('isolates shared-worktree pending questions and ignores unknown or detached sessions', () => {
    rememberAttachedRoot('root_a', '/shared');
    rememberAttachedRoot('root_b', '/shared');
    rememberChildSession({ childId: 'child_b', parentId: 'root_b' });
    const sessions: HandlerSessionSnapshot[] = [
      { kiloSessionId: 'root_a', lastActivityAt: 0 },
      { kiloSessionId: 'root_b', lastActivityAt: 0 },
    ];
    for (const [sessionID, id] of [
      ['root_a', 'question_a'],
      ['child_b', 'question_b'],
    ]) {
      updateSessionSnapshots(
        { type: 'question.asked', directory: '/shared', properties: { sessionID, id } },
        sessions,
        1
      );
    }
    updateSessionSnapshots(
      {
        type: 'question.rejected',
        directory: '/shared',
        properties: { sessionID: 'child_b', requestID: 'question_b' },
      },
      sessions,
      2
    );
    expect(sessions).toEqual([
      { kiloSessionId: 'root_a', lastActivityAt: 1, pendingInputs: new Set(['question_a']) },
      { kiloSessionId: 'root_b', lastActivityAt: 2 },
    ]);

    forgetAttachedRoot('root_b');
    for (const sessionID of ['unknown', 'root_b', 'child_b']) {
      updateSessionSnapshots(
        { type: 'question.asked', directory: '/shared', properties: { sessionID, id: 'late' } },
        sessions,
        3
      );
    }
    expect(sessions).toEqual([
      { kiloSessionId: 'root_a', lastActivityAt: 1, pendingInputs: new Set(['question_a']) },
      { kiloSessionId: 'root_b', lastActivityAt: 2 },
    ]);
  });

  it('records cross-directory child activity but rejects events from another root directory', () => {
    rememberAttachedRoot('root_a', '/a');
    rememberAttachedRoot('root_b', '/b');
    rememberChildSession({ childId: 'child', parentId: 'root_a', directory: '/child' });
    const sessions: HandlerSessionSnapshot[] = [
      { kiloSessionId: 'root_a', lastActivityAt: 0 },
      { kiloSessionId: 'root_b', lastActivityAt: 0 },
    ];
    updateSessionSnapshots(
      { type: 'question.asked', directory: '/child', properties: { sessionID: 'child', id: 'q' } },
      sessions,
      1
    );
    updateSessionSnapshots(
      {
        type: 'question.replied',
        directory: '/b',
        properties: { sessionID: 'child', requestID: 'q' },
      },
      sessions,
      2
    );
    updateSessionSnapshots(
      {
        type: 'session.status',
        directory: '/b',
        properties: { sessionID: 'root_a', status: { type: 'busy' } },
      },
      sessions,
      3
    );
    expect(sessions).toEqual([
      { kiloSessionId: 'root_a', lastActivityAt: 1, pendingInputs: new Set(['q']) },
      { kiloSessionId: 'root_b', lastActivityAt: 0 },
    ]);
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

describe('source runtime identity', () => {
  it.each(['session.created', 'session.updated'])(
    'rejects %s and activity from a child directory subsequently claimed by an independent root',
    type => {
      rememberAttachedRoot('root_a', '/a');
      rememberChildSession({ childId: 'child_a', parentId: 'root_a', directory: '/child-dir' });
      expect(sessionEventIdentity({ sessionId: 'child_a', runtimeDirectory: '/a' })).toEqual({
        directory: '/child-dir',
        kiloSessionId: 'child_a',
        rootKiloSessionId: 'root_a',
      });
      rememberAttachedRoot('root_b', '/child-dir');
      const sessions: HandlerSessionSnapshot[] = [
        { kiloSessionId: 'root_a', lastActivityAt: 0 },
        { kiloSessionId: 'root_b', lastActivityAt: 0 },
      ];
      const events = [
        {
          type,
          directory: '/child-dir',
          properties: { info: { id: 'child_a', parentID: 'root_a', directory: '/child-dir' } },
        },
        {
          type,
          directory: '/another-external',
          properties: {
            info: { id: 'late_child', parentID: 'child_a', directory: '/another-external' },
          },
        },
        {
          type: 'question.asked',
          directory: '/child-dir',
          properties: { sessionID: 'child_a', id: 'question_a' },
        },
        { type: 'session.idle', properties: { sessionID: 'child_a' } },
      ];
      for (const event of events) {
        for (const runtimeDirectory of ['/a', '/child-dir']) {
          expect(
            sessionEventIdentity({
              ...event,
              sessionId: eventKiloSessionId(event.properties),
              runtimeDirectory,
            })
          ).toBeUndefined();
        }
        updateSessionSnapshots(event, sessions, 1);
      }
      expect(sessions).toEqual([
        { kiloSessionId: 'root_a', lastActivityAt: 0 },
        { kiloSessionId: 'root_b', lastActivityAt: 0 },
      ]);
      expect(rootForSession('late_child')).toBeUndefined();
      expect(directoryForSession('late_child')).toBeUndefined();
      expect(sessionEventIdentity({ sessionId: 'root_b', runtimeDirectory: '/child-dir' })).toEqual(
        {
          directory: '/child-dir',
          kiloSessionId: 'root_b',
          rootKiloSessionId: 'root_b',
        }
      );
    }
  );

  it.each([
    { source: '/a', target: '/b', targetRoot: 'root_b' },
    { source: '/b', target: '/a', targetRoot: 'root_a' },
  ])(
    'prevents $source from mutating $target lineage or snapshots',
    ({ source, target, targetRoot }) => {
      rememberAttachedRoot('root_a', '/a');
      rememberAttachedRoot('root_b', '/b');
      rememberChildSession({
        childId: 'known_child',
        parentId: targetRoot,
        directory: '/descendant',
      });
      const sessions: HandlerSessionSnapshot[] = [
        { kiloSessionId: 'root_a', lastActivityAt: 0, pendingInputs: new Set(['question_a']) },
        { kiloSessionId: 'root_b', lastActivityAt: 0, pendingInputs: new Set(['question_b']) },
      ];
      const before = structuredClone(sessions);
      const events = [
        ...['session.created', 'session.updated'].flatMap(type =>
          [target, '/new-descendant', undefined].map(directory => ({
            type,
            directory,
            properties: { info: { id: 'spoof', parentID: targetRoot, directory } },
          }))
        ),
        {
          type: 'question.asked',
          directory: target,
          properties: { sessionID: targetRoot, id: 'spoof' },
        },
        {
          type: 'question.replied',
          directory: target,
          properties: {
            sessionID: targetRoot,
            requestID: targetRoot === 'root_a' ? 'question_a' : 'question_b',
          },
        },
        {
          type: 'question.asked',
          directory: '/descendant',
          properties: { sessionID: 'known_child', id: 'spoof' },
        },
        { type: 'session.idle', properties: { sessionID: targetRoot } },
        { type: 'session.status', directory: target, properties: {} },
      ];
      for (const event of events) {
        const identity = sessionEventIdentity({
          ...event,
          sessionId: eventKiloSessionId(event.properties),
          runtimeDirectory: source,
        });
        if (identity) updateSessionSnapshots(event, sessions, 1);
        expect(identity).toBeUndefined();
        expect(rootForSession('spoof')).toBeUndefined();
        expect(directoryForSession('spoof')).toBeUndefined();
        expect(rootForSession('known_child')).toBe(targetRoot);
        expect(directoryForSession('known_child')).toBe('/descendant');
        expect(sessions).toEqual(before);
      }
    }
  );

  it.each(['session.created', 'session.updated'])(
    'accepts %s for a registered pending root before feed startup and snapshot creation',
    type => {
      rememberAttachedRoot('pending_root', '/pending');
      const sessions: HandlerSessionSnapshot[] = [];
      const event = {
        type,
        directory: '/pending',
        properties: { info: { id: 'pending_root', directory: '/pending' } },
      };
      const identity = sessionEventIdentity({
        ...event,
        sessionId: eventKiloSessionId(event.properties),
        runtimeDirectory: '/pending',
      });
      expect(identity).toEqual({
        directory: '/pending',
        kiloSessionId: 'pending_root',
        rootKiloSessionId: 'pending_root',
      });
      if (identity) updateSessionSnapshots(event, sessions, 1);
      expect(sessions).toEqual([]);
    }
  );

  it('accepts source-owned descendants in other directories and updates only their root snapshot', () => {
    rememberAttachedRoot('root_a', '/a');
    rememberAttachedRoot('root_b', '/b');
    const sessions: HandlerSessionSnapshot[] = [
      { kiloSessionId: 'root_a', lastActivityAt: 0 },
      { kiloSessionId: 'root_b', lastActivityAt: 0 },
    ];
    for (const [root, source] of [
      ['root_a', '/a'],
      ['root_b', '/b'],
    ]) {
      const childId = `child_${root}`;
      const directory = `${source}/descendant`;
      const created = {
        type: 'session.created',
        directory,
        properties: { info: { id: childId, parentID: root, directory } },
      };
      const identity = sessionEventIdentity({
        ...created,
        sessionId: eventKiloSessionId(created.properties),
        runtimeDirectory: source,
      });
      expect(identity).toEqual({ directory, kiloSessionId: childId, rootKiloSessionId: root });
      expect(rootForSession(childId)).toBe(root);
      const nestedId = `nested_${root}`;
      expect(
        sessionEventIdentity({
          type: 'session.updated',
          sessionId: nestedId,
          properties: { info: { id: nestedId, parentID: childId } },
          runtimeDirectory: source,
        })
      ).toEqual({ directory, kiloSessionId: nestedId, rootKiloSessionId: root });

      const event = {
        type: 'question.asked',
        properties: { sessionID: nestedId, id: `question_${root}` },
      };
      const questionIdentity = sessionEventIdentity({
        ...event,
        sessionId: eventKiloSessionId(event.properties),
        runtimeDirectory: source,
      });
      expect(questionIdentity).toEqual({
        directory,
        kiloSessionId: nestedId,
        rootKiloSessionId: root,
      });
      if (questionIdentity) updateSessionSnapshots(event, sessions, 1);
      expect(
        sessionEventIdentity({ sessionId: nestedId, directory, runtimeDirectory: directory })
      ).toBeUndefined();
    }
    expect(sessions).toEqual([
      { kiloSessionId: 'root_a', lastActivityAt: 1, pendingInputs: new Set(['question_root_a']) },
      { kiloSessionId: 'root_b', lastActivityAt: 1, pendingInputs: new Set(['question_root_b']) },
    ]);
  });

  it('keeps sibling roots in a shared source runtime distinct', () => {
    rememberAttachedRoot('first', '/shared');
    rememberChildSession({ childId: 'first_child', parentId: 'first' });
    rememberAttachedRoot('second', '/shared');
    expect(sessionEventIdentity({ sessionId: 'first_child', runtimeDirectory: '/shared' })).toEqual(
      {
        directory: '/shared',
        kiloSessionId: 'first_child',
        rootKiloSessionId: 'first',
      }
    );
    for (const root of ['first', 'second']) {
      expect(sessionEventIdentity({ sessionId: root, runtimeDirectory: '/shared' })).toEqual({
        directory: '/shared',
        kiloSessionId: root,
        rootKiloSessionId: root,
      });
    }
    expect(
      sessionEventIdentity({ directory: '/shared', runtimeDirectory: '/shared' })
    ).toBeUndefined();
  });
});

describe('session event identity', () => {
  it.each(['session.created', 'session.updated'])(
    'routes a never-run child from %s metadata without inferring from a shared directory',
    type => {
      rememberAttachedRoot('root_a', '/shared');
      rememberAttachedRoot('root_b', '/shared');
      expect(
        sessionEventIdentity({
          type,
          properties: { info: { id: 'child', parentID: 'root_a', directory: '/shared' } },
          sessionId: 'child',
          directory: '/shared',
        })
      ).toEqual({ directory: '/shared', kiloSessionId: 'child', rootKiloSessionId: 'root_a' });
    }
  );

  it('rejects unknown parents and other roots directories without caching rejected lineage', () => {
    rememberAttachedRoot('root_a', '/a');
    rememberAttachedRoot('root_b', '/b');
    for (const parentID of ['unknown', 'root_b']) {
      expect(
        sessionEventIdentity({
          type: 'session.created',
          properties: { info: { id: 'spoof', parentID, directory: '/a' } },
          sessionId: 'spoof',
          directory: '/a',
        })
      ).toBeUndefined();
      expect(rootForSession('spoof')).toBeUndefined();
      expect(directoryForSession('spoof')).toBeUndefined();
    }
  });

  it.each(['session.created', 'session.updated'])(
    'rejects conflicting envelope and %s metadata before remembering a child',
    type => {
      rememberAttachedRoot('root_a', '/a');
      rememberAttachedRoot('root_b', '/b');
      expect(
        sessionEventIdentity({
          type,
          properties: { info: { id: 'spoof', parentID: 'root_a', directory: '/a' } },
          sessionId: 'spoof',
          directory: '/b',
        })
      ).toBeUndefined();
      expect(rootForSession('spoof')).toBeUndefined();
      expect(directoryForSession('spoof')).toBeUndefined();
    }
  );

  it('preserves known-lineage cross-directory descendants and their terminal events', () => {
    rememberAttachedRoot('root_a', '/shared');
    rememberAttachedRoot('root_b', '/shared');
    const identity = {
      directory: '/child-worktree',
      kiloSessionId: 'child_b',
      rootKiloSessionId: 'root_b',
    };
    expect(
      sessionEventIdentity({
        type: 'session.updated',
        sessionId: 'child_b',
        properties: { info: { id: 'child_b', parentID: 'root_b', directory: '/child-worktree' } },
      })
    ).toEqual(identity);
    expect(
      sessionEventIdentity({
        type: 'session.created',
        sessionId: 'nested_b',
        properties: { info: { id: 'nested_b', parentID: 'child_b' } },
      })
    ).toEqual({ ...identity, kiloSessionId: 'nested_b' });

    for (const type of ['session.idle', 'session.turn.close', 'session.error']) {
      const properties = { sessionID: 'child_b', messageID: 'msg_child' };
      expect(
        sessionEventIdentity({
          type,
          properties,
          sessionId: eventKiloSessionId(properties),
          directory: '/child-worktree',
        })
      ).toEqual(identity);
    }
    expect(sessionEventIdentity({ sessionId: 'child_b', directory: '/shared' })).toBeUndefined();
  });

  it('drops detached root and child events instead of assigning them to the surviving sibling', () => {
    rememberAttachedRoot('root_a', '/shared');
    rememberAttachedRoot('root_b', '/shared');
    rememberChildSession({ childId: 'child_b', parentId: 'root_b', directory: '/shared' });
    forgetAttachedRoot('root_b');

    expect(sessionEventIdentity({ sessionId: 'root_b', directory: '/shared' })).toBeUndefined();
    expect(sessionEventIdentity({ sessionId: 'child_b', directory: '/shared' })).toBeUndefined();
    expect(
      sessionEventIdentity({
        type: 'session.updated',
        sessionId: 'late_child',
        directory: '/shared',
        properties: { info: { id: 'late_child', parentID: 'root_b' } },
      })
    ).toBeUndefined();
    expect(sessionEventIdentity({ sessionId: 'root_a', directory: '/shared' })).toEqual({
      directory: '/shared',
      kiloSessionId: 'root_a',
      rootKiloSessionId: 'root_a',
    });
  });

  it('rejects attempts to reparent roots or children and mismatched child IDs', () => {
    rememberAttachedRoot('root_a', '/shared');
    rememberAttachedRoot('root_b', '/shared');
    rememberChildSession({ childId: 'child', parentId: 'root_a' });
    for (const id of ['root_a', 'child', 'different']) {
      expect(
        sessionEventIdentity({
          type: 'session.created',
          sessionId: id === 'different' ? 'spoof' : id,
          directory: '/shared',
          properties: { info: { id, parentID: 'root_b' } },
        })
      ).toBeUndefined();
    }
    expect(rootForSession('root_a')).toBe('root_a');
    expect(rootForSession('child')).toBe('root_a');
    expect(rootForSession('different')).toBeUndefined();
  });

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
    expect(childFromSessionCreated({ info: { id: 'root', directory: '/ws' } })).toBeUndefined();
    expect(childFromSessionCreated({ info: { id: 'root', parentID: null } })).toBeUndefined();
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

    expect(sessionEventIdentity({ sessionId: 'unknown', directory: '/ws' })).toBeUndefined();
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
    expect(sessionEventIdentity({ directory: '/ws' })).toBeUndefined();
  });

  it('returns no identity when neither session nor directory is known', () => {
    expect(sessionEventIdentity({ sessionId: 'unknown' })).toBeUndefined();
  });
});
