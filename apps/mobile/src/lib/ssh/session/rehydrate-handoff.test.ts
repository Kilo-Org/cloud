import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type SessionInfo } from '../../../../modules/kilo-ssh/src';
import { type SshHost } from '../hosts';

/**
 * The route/identity handoff across a JavaScript reload.
 *
 * A reload empties the session store but not the native registry, and the
 * router restores the terminal's route with the id it had before. This suite
 * asserts the two meet: the adopted row keeps the id the route names, and until
 * the adoption pass has run an absent session is not reported as a closed one.
 *
 * Each case imports the modules after `resetModules`: the store and the
 * adoption flag are module singletons, and a reload is exactly a fresh
 * singleton, so a static import could not model one.
 */

const HOST: SshHost = {
  id: 'host-1',
  label: 'bastion',
  hostname: '172.19.0.4',
  port: 2222,
  username: 'user',
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
};

const nativeSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 'session-1',
  appSessionId: 'app-session-1',
  viaSessionId: null,
  host: HOST.hostname,
  port: HOST.port,
  username: HOST.username,
  shellIds: ['shell-1'],
  sftpIds: [],
  forwardIds: [],
  ...overrides,
});

const state = vi.hoisted(() => ({
  sessions: [] as SessionInfo[],
}));

vi.mock('../../../../modules/kilo-ssh/src', () => ({}));

vi.mock('../native', () => ({
  sshPackage: () =>
    Promise.resolve({
      listSessions: () => Promise.resolve(state.sessions),
      listForwards: () => Promise.resolve([]),
      stopForwardById: () => Promise.resolve(),
    }),
}));

vi.mock('../store', () => ({ sshDatabase: () => Promise.resolve({}) }));
vi.mock('../hosts', () => ({ listHosts: () => [HOST] }));
vi.mock('../forwards', () => ({ listForwardsForHost: () => [] }));
vi.mock('../forwards-runtime', () => ({
  adoptForwards: () => undefined,
  resetSessionForwards: () => Promise.resolve(),
}));
vi.mock('./manager', () => ({ ensureSshEvents: () => Promise.resolve() }));
vi.mock('./idle-notify', () => ({ forgetIdleNotify: () => undefined }));

beforeEach(() => {
  vi.resetModules();
  state.sessions = [];
});

describe('rehydrating after a reload', () => {
  it('keeps the id the restored route names, so the terminal finds its row', async () => {
    state.sessions = [nativeSession()];
    const store = await import('./session-store');
    const { rehydrateSshSessions } = await import('./rehydrate');

    await rehydrateSshSessions();

    // The row the route at `/ssh/session/app-session-1` resolves against.
    const adopted = store.sessionById('app-session-1');
    expect(adopted).not.toBeNull();
    expect(adopted?.nativeSessionId).toBe('session-1');
    expect(adopted?.shellId).toBe('shell-1');
    expect(adopted?.phase).toEqual({ kind: 'connected' });
    // No second row for one connection.
    expect(store.sessionList()).toHaveLength(1);
  });

  it('does not invent a row for an anonymous jump connection', async () => {
    state.sessions = [nativeSession({ appSessionId: '' })];
    const store = await import('./session-store');
    const { rehydrateSshSessions } = await import('./rehydrate');

    const result = await rehydrateSshSessions();

    expect(result.adopted).toBe(0);
    expect(store.sessionList()).toEqual([]);
  });

  it('restores the exact hop ids on the target entry', async () => {
    state.sessions = [
      nativeSession({ sessionId: 'hop', appSessionId: '', shellIds: [] }),
      nativeSession({ viaSessionId: 'hop' }),
    ];
    const { rehydrateSshSessions } = await import('./rehydrate');
    const { live } = await import('./live');
    const result = await rehydrateSshSessions();
    expect(result.adopted).toBe(1);
    expect(live.get('app-session-1')?.jumpSessionIds).toEqual(['hop']);
    expect(live.size).toBe(1);
  });

  it('replaces a second row the dead runtime left under another id', async () => {
    state.sessions = [nativeSession({ appSessionId: 'fresh-id' })];
    const store = await import('./session-store');
    const { rehydrateSshSessions } = await import('./rehydrate');

    store.writeSession({
      id: 'fresh-id',
      hostId: HOST.id,
      label: HOST.label,
      target: 'user@172.19.0.4:2222',
      startedAt: 1,
      phase: { kind: 'closed', reason: 'disconnected', retryable: false },
      shellId: null,
      nativeSessionId: null,
      pendingCommand: null,
    });
    await rehydrateSshSessions();

    const adopted = store.sessionById('fresh-id');
    expect(adopted?.phase).toEqual({ kind: 'connected' });
    expect(adopted?.shellId).toBe('shell-1');
    expect(store.sessionList()).toHaveLength(1);
  });

  it('reports an absent session only after the adoption pass', async () => {
    state.sessions = [nativeSession()];
    const store = await import('./session-store');
    const { rehydrateSshSessions } = await import('./rehydrate');

    // What the terminal sees on the render that precedes the pass.
    expect(store.sessionsRehydrated()).toBe(false);
    expect(store.sessionById('app-session-1')).toBeNull();

    await rehydrateSshSessions();

    expect(store.sessionsRehydrated()).toBe(true);
    expect(store.sessionById('app-session-1')).not.toBeNull();
  });

  it('leaves the store empty for a session the registry lost', async () => {
    state.sessions = [];
    const store = await import('./session-store');
    const { rehydrateSshSessions } = await import('./rehydrate');

    await rehydrateSshSessions();

    // A reload starts with an empty store; nothing may invent a row for a
    // connection the registry no longer holds.
    expect(store.sessionList()).toEqual([]);
    expect(store.sessionsRehydrated()).toBe(true);
  });
});
