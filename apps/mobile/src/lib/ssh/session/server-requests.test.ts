import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type KeyboardInteractiveRequest } from '../../../../modules/kilo-ssh/src';
import { type LiveSession } from './live';
import { handlePrompts } from './server-requests';

const state = vi.hoisted(() => ({
  live: new Map<string, LiveSession>(),
  answerPrompts: vi.fn(),
  setPhase: vi.fn(),
}));

vi.mock('../native', () => ({
  sshPackage: () => Promise.resolve({ answerPrompts: state.answerPrompts }),
}));
vi.mock('../store', () => ({ sshDatabase: vi.fn() }));
vi.mock('../known-hosts', () => ({ findKnownHost: vi.fn(), trustHostKey: vi.fn() }));
vi.mock('./attempt', () => ({ fail: vi.fn(), forgetSession: vi.fn() }));
vi.mock('./session-store', () => ({ patchSession: vi.fn() }));
vi.mock('./live', () => ({ live: state.live, setPhase: state.setPhase, stillOpen: vi.fn() }));

const request = (prompts: KeyboardInteractiveRequest['prompts']): KeyboardInteractiveRequest => ({
  sessionId: 'native-1',
  requestId: 'request-1',
  name: '',
  instructions: '',
  prompts,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.live.clear();
});

describe('keyboard-interactive rounds', () => {
  it('acknowledges the final empty PAM round without opening an empty sheet', async () => {
    const entry = { connecting: true, prompts: null, promptsHostId: 'host-1' } as LiveSession;
    state.live.set('session-1', entry);

    handlePrompts(request([]));

    await vi.waitFor(() => expect(state.answerPrompts).toHaveBeenCalledWith('request-1', []));
    expect(entry.prompts).toBeNull();
    expect(state.setPhase).not.toHaveBeenCalled();
  });

  it('still presents rounds that ask for an answer', () => {
    const entry = { connecting: true, prompts: null, promptsHostId: 'host-1' } as LiveSession;
    state.live.set('session-1', entry);
    const prompts = [{ text: 'Password', echo: false }];

    handlePrompts(request(prompts));

    expect(entry.prompts?.prompts).toEqual(prompts);
    expect(state.setPhase).toHaveBeenCalledWith(entry, {
      kind: 'awaiting-prompts',
      prompts: entry.prompts,
    });
    expect(state.answerPrompts).not.toHaveBeenCalled();
  });

  it('cancels even an empty round when no connection owns it', async () => {
    handlePrompts(request([]));
    await vi.waitFor(() => expect(state.answerPrompts).toHaveBeenCalledWith('request-1', null));
  });
});
