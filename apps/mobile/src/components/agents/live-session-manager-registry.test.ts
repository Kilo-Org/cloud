import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';

import { type SessionManager } from '@kilocode/cloud-agent-sdk';

import {
  getLiveSessionManager,
  registerLiveSessionManager,
  unregisterLiveSessionManager,
} from './live-session-manager-registry';

// Every case uses its own session id: the registry is module state, so a
// shared id would make one case observe another's registration.
function handleFor(label: string) {
  return {
    manager: { label } as unknown as SessionManager,
    store: createStore(),
  };
}

describe('live session manager registry', () => {
  it('returns null for a session that is not open', () => {
    expect(getLiveSessionManager('registry-session-absent')).toBeNull();
  });

  it('returns the registered handle for its session', () => {
    const handle = handleFor('registry-session-a');

    registerLiveSessionManager('registry-session-a', handle);

    expect(getLiveSessionManager('registry-session-a')).toBe(handle);
    expect(getLiveSessionManager('registry-session-other')).toBeNull();
  });

  it('unregisters the handle it registered', () => {
    const handle = handleFor('registry-session-b');
    registerLiveSessionManager('registry-session-b', handle);

    unregisterLiveSessionManager('registry-session-b', handle);

    expect(getLiveSessionManager('registry-session-b')).toBeNull();
  });

  it('keeps a registration that a newer provider replaced', () => {
    const first = handleFor('registry-session-c');
    const second = handleFor('registry-session-c');
    registerLiveSessionManager('registry-session-c', first);
    registerLiveSessionManager('registry-session-c', second);

    unregisterLiveSessionManager('registry-session-c', first);

    expect(getLiveSessionManager('registry-session-c')).toBe(second);
  });
});
