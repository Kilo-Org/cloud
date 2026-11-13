import { describe, expect, it } from 'vitest';

import { type ForwardInfo, type SessionInfo } from '../../../../modules/kilo-ssh/src';
import { type SshForward } from '../forwards';
import { type SshHost } from '../hosts';
import { nativeTarget, planForwards, planSessions, planStale } from './rehydrate-plan';

function host(overrides: Partial<SshHost> & { id: string }): SshHost {
  return {
    label: overrides.id,
    hostname: `${overrides.id}.test`,
    port: 22,
    username: 'igor',
    authMethod: 'password',
    password: null,
    keyId: null,
    jumpHostId: null,
    tmuxAttach: false,
    tmuxSessionName: null,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    lastConnectedAt: null,
    ...overrides,
  };
}

function session(overrides: Partial<SessionInfo> & { sessionId: string }): SessionInfo {
  return {
    host: 'web.test',
    port: 22,
    username: 'igor',
    shellIds: [],
    sftpIds: [],
    forwardIds: [],
    ...overrides,
  };
}

function forward(overrides: Partial<ForwardInfo> & { forwardId: string }): ForwardInfo {
  return {
    sessionId: 'session-1',
    direction: 'local',
    bindHost: '127.0.0.1',
    bindPort: 8080,
    port: 8080,
    ...overrides,
  };
}

function stored(overrides: Partial<SshForward> & { id: string }): SshForward {
  return {
    hostId: 'web',
    direction: 'local',
    bindHost: '127.0.0.1',
    bindPort: 8080,
    destinationHost: 'db.internal',
    destinationPort: 5432,
    autoStart: true,
    label: null,
    ...overrides,
  };
}

describe('adopting native sessions', () => {
  it('names a session by the target it was opened for', () => {
    expect(nativeTarget({ username: 'igor', host: 'web.test', port: 2222 })).toBe(
      'igor@web.test:2222'
    );
  });

  it('adopts the live shell of a session whose runtime is gone', () => {
    const web = host({ id: 'web' });
    const plan = planSessions(
      [session({ sessionId: 'session-1', shellIds: ['shell-1'] })],
      [web],
      new Set()
    );

    expect(plan.adopt).toEqual([
      { native: expect.objectContaining({ sessionId: 'session-1' }), host: web, shellId: 'shell-1' },
    ]);
    expect(plan.unmatched).toEqual([]);
  });

  it('adopts a connection whose shell is not open as connected without a shell', () => {
    const plan = planSessions([session({ sessionId: 'session-1' })], [host({ id: 'web' })], new Set());

    expect(plan.adopt[0]?.shellId).toBeNull();
  });

  it('keeps a session out of the app when its host row is gone', () => {
    const plan = planSessions([session({ sessionId: 'session-1' })], [], new Set());

    expect(plan.adopt).toEqual([]);
    expect(plan.unmatched.map(item => item.sessionId)).toEqual(['session-1']);
  });

  it('leaves a session this runtime already tracks alone', () => {
    const plan = planSessions(
      [session({ sessionId: 'session-1' })],
      [host({ id: 'web' })],
      new Set(['session-1'])
    );

    expect(plan.adopt).toEqual([]);
    expect(plan.unmatched).toEqual([]);
  });

  it('matches a non-default port only against the same port', () => {
    // Same hostname on both rows: only the port tells the two hosts apart.
    const plan = planSessions(
      [session({ sessionId: 'session-1', port: 2222 })],
      [host({ id: 'web' }), host({ id: 'web-alt', hostname: 'web.test', port: 2222 })],
      new Set()
    );

    expect(plan.adopt.map(item => item.host.id)).toEqual(['web-alt']);
  });
});

describe('reconciling listeners', () => {
  const targets = new Map([
    ['session-1', { sessionId: 'app-1', forwards: [stored({ id: 'forward-row' })] }],
  ]);

  it('pairs a listening forward with the row that opened it', () => {
    const plan = planForwards([forward({ forwardId: 'forward-1' })], targets);

    expect(plan.adopt).toEqual([
      {
        sessionId: 'app-1',
        nativeSessionId: 'session-1',
        forwards: [{ forwardId: 'forward-row', nativeForwardId: 'forward-1', port: 8080 }],
      },
    ]);
    expect(plan.orphans).toEqual([]);
  });

  it('reports the bound port, not the requested one', () => {
    const plan = planForwards(
      [forward({ forwardId: 'forward-1', bindPort: 0, port: 51234 })],
      new Map([
        ['session-1', { sessionId: 'app-1', forwards: [stored({ id: 'row', bindPort: 0 })] }],
      ])
    );

    expect(plan.adopt[0]?.forwards[0]?.port).toBe(51234);
  });

  it('stops a listener whose stored row was deleted', () => {
    const plan = planForwards([forward({ forwardId: 'forward-1' })], new Map());

    expect(plan.adopt).toEqual([]);
    expect(plan.orphans).toEqual(['forward-1']);
  });

  it('stops a listener whose row no longer matches the bind address', () => {
    const plan = planForwards(
      [forward({ forwardId: 'forward-1', bindHost: '0.0.0.0' })],
      targets
    );

    expect(plan.orphans).toEqual(['forward-1']);
  });

  it('separates listeners by direction', () => {
    const plan = planForwards([forward({ forwardId: 'forward-1', direction: 'remote' })], targets);

    expect(plan.orphans).toEqual(['forward-1']);
  });
});

describe('dropping sessions the registry no longer holds', () => {
  it('names an entry whose native connection is gone', () => {
    const stale = planStale(
      [
        { id: 'app-1', nativeSessionId: 'session-1' },
        { id: 'app-2', nativeSessionId: 'session-2' },
      ],
      new Set(['session-2'])
    );

    expect(stale).toEqual(['app-1']);
  });

  it('keeps an entry that never reached a native session', () => {
    expect(planStale([{ id: 'app-1', nativeSessionId: null }], new Set())).toEqual([]);
  });
});