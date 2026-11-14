import { beforeEach, expect, it, vi } from 'vitest';

import { type SshHost } from '../hosts';
import { attempt, fail } from './attempt';
import { live, type LiveSession } from './live';
import { sessionById, writeSession } from './session-store';

const state = vi.hoisted(() => ({
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
vi.mock('../store', () => ({ sshDatabase: () => Promise.resolve({}) }));
vi.mock('../hosts', () => ({ getHost: state.getHost, updateHost: vi.fn() }));
vi.mock('../keys', () => ({ getKey: () => ({ privateKeyOpenssh: 'key', passphrase: null }) }));
vi.mock('../forwards', () => ({ listForwardsForHost: () => [] }));
vi.mock('../forwards-runtime', () => ({
  autoStartForwards: vi.fn(),
  resetSessionForwards: vi.fn(),
}));
vi.mock('./biometric', () => ({ requireKeyAccess: state.access }));
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
    promptsHostId: null,
    passphrase: null,
    connecting: false,
    connectTargets: [],
  };
}

let entry = createEntry();
beforeEach(() => {
  vi.clearAllMocks();
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
