import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type HostKeyRequest,
  type KeyboardInteractiveRequest,
} from '../../../../modules/kilo-ssh/src';
import { type LiveSession } from './live';
import { handleHostKey, handlePrompts } from './server-requests';

type ConnectingSession = Pick<
  LiveSession,
  'connecting' | 'connectAttemptId' | 'prompts' | 'hostKey'
>;

const state = vi.hoisted(() => ({
  live: new Map<string, ConnectingSession>(),
  answerHostKey: vi.fn(),
  answerPrompts: vi.fn(),
  setPhase: vi.fn(),
  sshDatabase: vi.fn(),
  stillOpen: vi.fn(),
}));

vi.mock('../native', () => ({
  sshPackage: () =>
    Promise.resolve({
      answerHostKey: state.answerHostKey,
      answerPrompts: state.answerPrompts,
    }),
}));
vi.mock('../store', () => ({ sshDatabase: state.sshDatabase }));
vi.mock('../known-hosts', () => ({ findKnownHost: () => null, trustHostKey: vi.fn() }));
vi.mock('./attempt', () => ({ fail: vi.fn(), forgetSession: vi.fn() }));
vi.mock('./session-store', () => ({ patchSession: vi.fn() }));
vi.mock('./live', () => ({
  live: state.live,
  setPhase: state.setPhase,
  stillOpen: state.stillOpen,
}));

function connect(attemptId: string): ConnectingSession {
  const entry: ConnectingSession = {
    connecting: true,
    connectAttemptId: attemptId,
    prompts: null,
    hostKey: null,
  };
  state.live.set(attemptId, entry);
  return entry;
}

const request = (
  prompts: KeyboardInteractiveRequest['prompts'],
  attemptId = 'attempt-1'
): KeyboardInteractiveRequest => ({
  sessionId: `native-${attemptId}`,
  attemptId,
  requestId: `prompts-${attemptId}`,
  name: '',
  instructions: '',
  prompts,
});

const hostKey = (attemptId: string): HostKeyRequest => ({
  sessionId: `native-${attemptId}`,
  attemptId,
  requestId: `key-${attemptId}`,
  host: 'same.test',
  port: 22,
  algorithm: 'ssh-ed25519',
  publicKeyBase64: `key-${attemptId}`,
  fingerprintSha256: `SHA256:${attemptId}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.live.clear();
  state.sshDatabase.mockResolvedValue({});
  state.stillOpen.mockReturnValue(true);
});

describe('host-key requests', () => {
  it('routes reversed requests for the same host and port to their own attempts', async () => {
    const first = connect('first');
    const second = connect('second');

    handleHostKey(hostKey('second'));
    handleHostKey(hostKey('first'));

    await vi.waitFor(() => {
      expect(second.hostKey?.requestId).toBe('key-second');
      expect(first.hostKey?.requestId).toBe('key-first');
    });
    expect(second.hostKey?.fingerprintSha256).toBe('SHA256:second');
    expect(first.hostKey?.fingerprintSha256).toBe('SHA256:first');
    expect(state.answerHostKey).not.toHaveBeenCalled();
  });

  it.each(['', 'previous-attempt'])('refuses an unowned request token %j', async attemptId => {
    const current = connect('current');

    handleHostKey(hostKey(attemptId));

    await vi.waitFor(() => {
      expect(state.answerHostKey).toHaveBeenCalledWith(`key-${attemptId}`, false);
    });
    expect(current.hostKey).toBeNull();
    expect(state.setPhase).not.toHaveBeenCalled();
  });

  it('refuses a request whose attempt changed while reading known hosts', async () => {
    const database = Promise.withResolvers<object>();
    state.sshDatabase.mockReturnValue(database.promise);
    const entry = connect('previous');

    handleHostKey(hostKey('previous'));
    entry.connectAttemptId = 'next-hop';
    database.resolve({});

    await vi.waitFor(() => {
      expect(state.answerHostKey).toHaveBeenCalledWith('key-previous', false);
    });
    expect(entry.hostKey).toBeNull();
    expect(state.setPhase).not.toHaveBeenCalled();
  });
});

describe('keyboard-interactive rounds', () => {
  it('routes concurrent password prompts to the originating attempt', () => {
    const first = connect('first');
    const second = connect('second');
    const firstPrompts = [{ text: 'First password', echo: false }];
    const secondPrompts = [{ text: 'Second password', echo: false }];

    handlePrompts(request(secondPrompts, 'second'));
    handlePrompts(request(firstPrompts, 'first'));

    expect(second.prompts?.requestId).toBe('prompts-second');
    expect(second.prompts?.prompts).toEqual(secondPrompts);
    expect(first.prompts?.requestId).toBe('prompts-first');
    expect(first.prompts?.prompts).toEqual(firstPrompts);
    expect(state.answerPrompts).not.toHaveBeenCalled();
  });

  it('acknowledges the final empty PAM round without opening an empty sheet', async () => {
    const entry = connect('attempt-1');

    handlePrompts(request([]));

    await vi.waitFor(() => {
      expect(state.answerPrompts).toHaveBeenCalledWith('prompts-attempt-1', []);
    });
    expect(entry.prompts).toBeNull();
    expect(state.setPhase).not.toHaveBeenCalled();
  });

  it('still presents rounds that ask for an answer', () => {
    const entry = connect('attempt-1');
    const prompts = [{ text: 'Password', echo: false }];

    handlePrompts(request(prompts));

    expect(entry.prompts?.prompts).toEqual(prompts);
    expect(state.setPhase).toHaveBeenCalledWith(entry, {
      kind: 'awaiting-prompts',
      prompts: entry.prompts,
    });
    expect(state.answerPrompts).not.toHaveBeenCalled();
  });

  it.each(['', 'previous-attempt'])('cancels an unowned round %j', async attemptId => {
    const entry = connect('current');

    handlePrompts(request([{ text: 'Password', echo: false }], attemptId));

    await vi.waitFor(() => {
      expect(state.answerPrompts).toHaveBeenCalledWith(`prompts-${attemptId}`, null);
    });
    expect(entry.prompts).toBeNull();
  });

  it('cancels even an empty round when no connection owns it', async () => {
    handlePrompts(request([]));
    await vi.waitFor(() => {
      expect(state.answerPrompts).toHaveBeenCalledWith('prompts-attempt-1', null);
    });
  });
});
