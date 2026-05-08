import type * as ReactModule from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  cleanups: [] as (() => void)[],
  subscribe: vi.fn<(contexts: string[]) => void>(),
  unsubscribe: vi.fn<(contexts: string[]) => void>(),
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactModule>('react');
  return {
    ...actual,
    useEffect: (effect: ReactModule.EffectCallback) => {
      const cleanup = effect();
      if (typeof cleanup === 'function') {
        testState.cleanups.push(cleanup);
      }
    },
  };
});

vi.mock('./context', () => ({
  useEventServiceClient: () => ({
    subscribe: testState.subscribe,
    unsubscribe: testState.unsubscribe,
  }),
}));

import { usePresenceSubscription } from './use-presence-subscription';

describe('usePresenceSubscription', () => {
  beforeEach(() => {
    testState.cleanups = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const cleanup of testState.cleanups) {
      cleanup();
    }
  });

  it('subscribes while active and unsubscribes on cleanup', () => {
    usePresenceSubscription('presence:instance:sandbox-1', true);

    expect(testState.subscribe).toHaveBeenCalledWith(['presence:instance:sandbox-1']);

    testState.cleanups[0]?.();

    expect(testState.unsubscribe).toHaveBeenCalledWith(['presence:instance:sandbox-1']);
  });

  it('does not subscribe without an active context', () => {
    usePresenceSubscription('presence:instance:sandbox-1', false);
    usePresenceSubscription(null, true);

    expect(testState.subscribe).not.toHaveBeenCalled();
    expect(testState.unsubscribe).not.toHaveBeenCalled();
  });
});
