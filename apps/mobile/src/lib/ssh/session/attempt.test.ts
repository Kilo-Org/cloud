import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { type SshHost } from '../hosts';
import type * as Biometric from './biometric';
import { attempt, fail } from './attempt';
import { live, type LiveSession } from './live';
import { closeSession, resumeSshSessions, retrySession } from './manager';
import { patchSession, sessionById, writeSession } from './session-store';

const state = vi.hoisted(() => ({
  remove: vi.fn<() => void>(),
  app: {
    currentState: 'active',
    addEventListener:
      vi.fn<(event: string, listener: (value: string) => void) => { remove: () => void }>(),
  },
  disconnect: vi.fn(),
  closeShell: vi.fn(),
  connect: vi.fn(),
  connectVia: vi.fn(),
  getHost: vi.fn<(db: unknown, id: string) => SshHost | null>(),
  openShell: vi.fn(),
  access: vi.fn(),
  host: {
    id: 'host',
    hostname: 'host.test',
    port: 22,
    username: 'user',
    label: 'host',
    authMethod: 'key',
    keyId: 'key',
    jumpHostId: null,
    tmuxAttach: false,
    password: null,
    tmuxSessionName: null,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    lastConnectedAt: null,
  } satisfies SshHost,
}));
vi.mock('@/i18n', () => ({ i18n: { t: () => 'Unlock' } }));
vi.mock('./idle-notify', () => ({ forgetIdleNotify: vi.fn() }));
vi.mock('../known-hosts', () => ({ findKnownHost: vi.fn(), trustHostKey: vi.fn() }));
vi.mock('../id', () => ({ newId: vi.fn(() => crypto.randomUUID()) }));
vi.mock('../store', () => ({ sshDatabase: () => Promise.resolve({}) }));
vi.mock('../hosts', () => ({ getHost: state.getHost, updateHost: vi.fn() }));
vi.mock('../keys', () => ({ getKey: () => ({ privateKeyOpenssh: 'key', passphrase: null }) }));
vi.mock('../forwards', () => ({ listForwardsForHost: () => [] }));
vi.mock('../forwards-runtime', () => ({
  autoStartForwards: vi.fn(),
  resetSessionForwards: vi.fn(),
}));
vi.mock('react-native', () => ({ AppState: state.app }));
vi.mock('./biometric', async importOriginal => {
  const original = await importOriginal<typeof Biometric>();
  return { ...original, requireKeyAccess: state.access };
});
vi.mock('../native', () => ({
  nativeErrorCode: () => 'ChannelClosed',
  sshPackage: () =>
    Promise.resolve({
      disconnect: state.disconnect,
      closeShell: state.closeShell,
      connect: state.connect,
      connectVia: state.connectVia,
      openShell: state.openShell,
      parsePrivateKey: vi.fn(),
    }),
}));

function createEntry(): LiveSession {
  return {
    id: 'app',
    host: state.host,
    nativeSessionId: 'target',
    jumpSessionIds: ['outer', 'inner'],
    attempt: 10,
    timer: null,
    hostKey: null,
    prompts: null,
    passwords: new Map(),
    authHostId: null,
    passphrase: null,
    connecting: false,
    attemptAbort: null,
    connectAttemptId: null,
  };
}

let entry = createEntry();
beforeEach(() => {
  vi.clearAllMocks();
  state.app.currentState = 'active';
  state.app.addEventListener.mockImplementation(() => ({ remove: state.remove }));
  live.clear();
  entry = createEntry();
  live.set(entry.id, entry);
  writeSession({
    id: 'app',
    hostId: 'host',
    label: 'host',
    target: 'user@host:22',
    startedAt: 0,
    nativeSessionId: 'target',
    shellId: 'shell',
    pendingCommand: null,
    phase: { kind: 'connected' },
  });
  state.getHost.mockReturnValue(state.host);
  state.access.mockResolvedValue(true);
  state.disconnect.mockResolvedValue(undefined);
  state.connect.mockResolvedValue('new-target');
  state.openShell.mockResolvedValue('new-shell');
});

afterEach(() => {
  vi.useRealTimers();
});

it('starts a requested retry immediately and clears the pending backoff timer', async () => {
  vi.useFakeTimers();
  entry.nativeSessionId = null;
  entry.jumpSessionIds = [];
  entry.attempt = 2;
  fail(entry, 'disconnected');
  expect(vi.getTimerCount()).toBe(1);
  expect(sessionById('app')?.phase.kind).toBe('reconnecting');

  state.connect.mockImplementationOnce(() => {
    expect(sessionById('app')?.phase).toEqual({ kind: 'connecting', attempt: 1 });
    return Promise.resolve('new-target');
  });
  retrySession('app');

  expect(entry.timer).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  expect(entry.connecting).toBe(true);
  await vi.waitFor(() => {
    expect(state.connect).toHaveBeenCalledTimes(1);
    expect(sessionById('app')?.phase.kind).toBe('connected');
  });
});

it('leaves an existing background socket untouched when sessions resume', () => {
  state.app.currentState = 'background';
  resumeSshSessions();
  state.app.currentState = 'active';
  resumeSshSessions();
  expect(state.connect).not.toHaveBeenCalled();
  expect(state.access).not.toHaveBeenCalled();
  expect(entry.nativeSessionId).toBe('target');
  expect(sessionById('app')?.phase.kind).toBe('connected');
});

it('keeps a background reconnect pending until the app is active, then unlocks once', async () => {
  entry.nativeSessionId = null;
  entry.jumpSessionIds = [];
  entry.attempt = 0;
  patchSession('app', {
    phase: { kind: 'reconnecting', attempt: 1, reason: 'disconnected' },
  });
  state.app.currentState = 'background';
  const reconnect = attempt(entry);
  await Promise.resolve();
  expect(sessionById('app')?.phase.kind).toBe('reconnecting');
  expect(entry.connecting).toBe(true);
  resumeSshSessions();
  expect(state.access).not.toHaveBeenCalled();
  expect(state.connect).not.toHaveBeenCalled();
  state.app.currentState = 'inactive';
  state.app.addEventListener.mock.calls[0]?.[1]('inactive');
  await Promise.resolve();
  expect(state.access).not.toHaveBeenCalled();
  state.app.currentState = 'active';
  resumeSshSessions();
  state.app.addEventListener.mock.calls[0]?.[1]('active');
  await reconnect;
  expect(state.access).toHaveBeenCalledTimes(1);
  expect(state.connect).toHaveBeenCalledTimes(1);
  expect(sessionById('app')?.phase.kind).toBe('connected');
  expect(state.remove).toHaveBeenCalledOnce();
});

it('disconnects target and hops and clears their ids on a channel ending', async () => {
  fail(entry, 'ChannelClosed');
  await vi.waitFor(() => {
    expect(state.disconnect).toHaveBeenCalledTimes(3);
  });
  expect(state.disconnect.mock.calls.map(call => call[0])).toEqual(['target', 'inner', 'outer']);
  expect(entry.nativeSessionId).toBeNull();
  expect(entry.jumpSessionIds).toEqual([]);
  expect(sessionById('app')?.nativeSessionId).toBeNull();
});

it('disconnects an already connected transport when opening its shell fails', async () => {
  entry.nativeSessionId = null;
  entry.jumpSessionIds = [];
  state.openShell.mockRejectedValueOnce(new Error('shell failed'));
  await attempt(entry);
  await vi.waitFor(() => {
    expect(state.disconnect).toHaveBeenCalledWith('new-target');
  });
  expect(entry.nativeSessionId).toBeNull();
});

it('consults the foreground key gate on every automatic attempt before sending a key', async () => {
  entry.nativeSessionId = null;
  entry.jumpSessionIds = [];
  await attempt(entry);
  state.access.mockResolvedValue(false);
  await attempt(entry);
  expect(state.access).toHaveBeenCalledTimes(2);
  expect(state.connect).toHaveBeenCalledTimes(1);
  expect(sessionById('app')?.phase).toEqual({
    kind: 'closed',
    reason: 'AuthCancelled',
    retryable: false,
  });
});

it('gives only the target its app row id while keeping hop connections anonymous', async () => {
  const target: SshHost = { ...state.host, jumpHostId: 'jump' };
  const jump: SshHost = { ...state.host, id: 'jump', hostname: 'jump.test' };
  state.getHost.mockImplementation((_db, id) => (id === 'jump' ? jump : target));
  state.connect.mockResolvedValue('hop');
  state.connectVia.mockResolvedValue('target');
  entry.nativeSessionId = null;
  entry.jumpSessionIds = [];
  await attempt(entry);
  expect(state.connect).toHaveBeenCalledWith(
    expect.objectContaining({ appSessionId: '', host: 'jump.test' })
  );
  expect(state.connectVia).toHaveBeenCalledWith(
    'hop',
    expect.objectContaining({ appSessionId: 'app', host: 'host.test' })
  );
  expect(entry.jumpSessionIds).toEqual(['hop']);
  expect(entry.nativeSessionId).toBe('target');
});

it.each(['typed-password', 'saved-password', 'keyboard-interactive'])(
  'reconnects %s in the background without waiting for an unlock',
  async authentication => {
    const host: SshHost = {
      ...state.host,
      authMethod: authentication === 'keyboard-interactive' ? 'keyboard_interactive' : 'password',
      password: authentication === 'saved-password' ? 'saved' : null,
    };
    state.getHost.mockReturnValue(host);
    if (authentication === 'typed-password') {
      entry.passwords.set(host.id, 'typed');
    }
    patchSession('app', { phase: { kind: 'reconnecting', attempt: 1, reason: 'disconnected' } });
    state.app.currentState = 'background';
    await attempt(entry);
    expect(state.connect).toHaveBeenCalledOnce();
    expect(state.access).not.toHaveBeenCalled();
    expect(state.app.addEventListener).not.toHaveBeenCalled();
    expect(sessionById('app')?.phase.kind).toBe('connected');
  }
);

it('waits for foreground when a password target has a key-authenticated jump host', async () => {
  const target: SshHost = {
    ...state.host,
    authMethod: 'password',
    password: 'saved',
    jumpHostId: 'jump',
  };
  const jump: SshHost = { ...state.host, id: 'jump' };
  state.getHost.mockImplementation((_db, id) => (id === 'jump' ? jump : target));
  state.connectVia.mockResolvedValue('target');
  patchSession('app', { phase: { kind: 'reconnecting', attempt: 1, reason: 'disconnected' } });
  state.app.currentState = 'background';
  const reconnect = attempt(entry);
  await vi.waitFor(() => {
    expect(state.app.addEventListener).toHaveBeenCalledOnce();
  });
  expect(state.connect).not.toHaveBeenCalled();
  state.app.currentState = 'active';
  state.app.addEventListener.mock.calls[0]?.[1]('active');
  await reconnect;
  expect(state.access).toHaveBeenCalledOnce();
  expect(state.connectVia).toHaveBeenCalledOnce();
});

it.each(['close', 'failure'])(
  'removes a background reconnect listener on session %s',
  async ending => {
    patchSession('app', { phase: { kind: 'reconnecting', attempt: 1, reason: 'disconnected' } });
    state.app.currentState = 'background';
    const reconnect = attempt(entry);
    await vi.waitFor(() => {
      expect(state.app.addEventListener).toHaveBeenCalledOnce();
    });
    if (ending === 'close') {
      await closeSession(entry.id);
    } else {
      fail(entry, 'user');
    }
    await reconnect;
    expect(state.remove).toHaveBeenCalledOnce();
    expect(entry.connecting).toBe(false);
    expect(entry.attemptAbort).toBeNull();
    expect(state.connect).not.toHaveBeenCalled();
    expect(state.access).not.toHaveBeenCalled();
    if (ending === 'failure') {
      expect(sessionById('app')?.phase).toEqual({
        kind: 'closed',
        reason: 'user',
        retryable: false,
      });
    }
  }
);
