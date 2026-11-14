import { beforeEach, describe, expect, it, vi } from 'vitest';

import { endShell } from './manager';
import { handleDisconnect } from './server-requests';
import { patchSession, sessionById, writeSession } from './session-store';
import { type LiveSession } from './live';

const state = vi.hoisted(() => ({
  live: new Map<string, Pick<LiveSession, 'id' | 'nativeSessionId' | 'jumpSessionIds'>>(),
  fail: vi.fn(),
}));
vi.mock('../id', () => ({ newId: vi.fn() }));
vi.mock('../native', () => ({ sshPackage: vi.fn() }));
vi.mock('../store', () => ({ sshDatabase: vi.fn() }));
vi.mock('../known-hosts', () => ({ findKnownHost: vi.fn(), trustHostKey: vi.fn() }));
vi.mock('@/lib/analytics/posthog', () => ({ captureEvent: vi.fn() }));
vi.mock('../forwards-runtime', () => ({
  handleForwardError: vi.fn(),
  resetSessionForwards: vi.fn(),
}));
vi.mock('./idle-notify', () => ({ forgetIdleNotify: vi.fn() }));
vi.mock('./attempt', () => ({ attempt: vi.fn(), fail: state.fail }));
vi.mock('./connection', () => ({ forgetSession: vi.fn() }));
vi.mock('./live', () => ({
  live: state.live,
  clearTimer: vi.fn(),
  setPhase: vi.fn(),
  stillOpen: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.live.clear();
  state.live.set('session', { id: 'session', nativeSessionId: 'native', jumpSessionIds: [] });
  writeSession({
    id: 'session',
    hostId: 'host',
    label: 'fixture',
    target: 'user@fixture:22',
    startedAt: 1,
    phase: { kind: 'connected' },
    shellId: 'shell',
    nativeSessionId: 'native',
    pendingCommand: null,
  });
  state.fail.mockImplementation(() => {
    patchSession('session', {
      shellId: null,
      phase: { kind: 'reconnecting', attempt: 2, reason: 'disconnected' },
    });
  });
});

describe('native transport and terminal close ordering', () => {
  it('keeps a disconnect retryable when terminal teardown reports a subsequent close', () => {
    handleDisconnect({ sessionId: 'native', reason: 'Network' });
    endShell('session', null);
    expect(state.fail).toHaveBeenCalledTimes(1);
    expect(sessionById('session')?.phase.kind).toBe('reconnecting');
  });

  it('still handles a remote exit while its shell is current', () => {
    endShell('session', null);
    expect(state.fail).toHaveBeenCalledWith(state.live.get('session'), 'user', {
      origin: 'session',
    });
  });
});
