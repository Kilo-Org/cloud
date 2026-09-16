import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _hydrateLastOpenedSessionForTests,
  _resetLastOpenedSessionForTests,
  _setLastOpenedSessionForTests,
  _setSecureStoreForTests,
  clearLastOpenedSession,
  getLastOpenedSession,
  getLastOpenedSessionSnapshot,
  type LastOpenedSessionRecord,
  recordLastOpenedSession,
  subscribeLastOpenedSession,
} from './last-opened-session';

const KEY = 'last-opened-session';

const store = new Map<string, string>();

// Fake SecureStore surface backed by an in-memory Map, injected through the
// test-only setter so the durable mirror never loads the real native module.
const secureStoreMock = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  }),
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
    await Promise.resolve();
  }),
};

function recordFor(sessionId: string, userId: string): string {
  return JSON.stringify({ sessionId, userId, storedAt: 1_700_000_000_000 });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let storedResolve: (() => void) | undefined = undefined;
  const promise = new Promise<void>(resolve => {
    storedResolve = resolve;
  });
  return {
    promise,
    resolve: () => {
      storedResolve?.();
    },
  };
}

/**
 * Let the serialized SecureStore mirror drain: the mock operations settle in
 * microtasks, so one macrotask boundary runs the whole chain.
 */
async function flushMirror(): Promise<void> {
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  _resetLastOpenedSessionForTests();
  _setSecureStoreForTests(secureStoreMock);
  store.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  _resetLastOpenedSessionForTests();
  store.clear();
});

describe('last opened session', () => {
  it('records the session for its account and mirrors the exact record shape', async () => {
    recordLastOpenedSession('s1', 'u1');

    expect(getLastOpenedSession('u1')).toBe('s1');
    expect(getLastOpenedSessionSnapshot()).toBe('s1');

    await flushMirror();
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledOnce();
    expect(secureStoreMock.setItemAsync.mock.calls[0]?.[0]).toBe(KEY);
    expect(JSON.parse(secureStoreMock.setItemAsync.mock.calls[0]?.[1] ?? '')).toEqual({
      sessionId: 's1',
      userId: 'u1',
      storedAt: expect.any(Number),
    });
  });

  it('records nothing without a signed-in account', () => {
    recordLastOpenedSession('s1', null);

    expect(getLastOpenedSessionSnapshot()).toBeNull();
    expect(getLastOpenedSession(null)).toBeNull();
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled();
  });

  it('never offers one account the session recorded for another', () => {
    recordLastOpenedSession('s1', 'u1');

    expect(getLastOpenedSession('u2')).toBeNull();
    expect(getLastOpenedSession(null)).toBeNull();
    expect(getLastOpenedSession('u1')).toBe('s1');
  });

  it('restores a mirrored record after a restart', async () => {
    store.set(KEY, recordFor('s7', 'u1'));

    await _hydrateLastOpenedSessionForTests();

    expect(getLastOpenedSessionSnapshot()).toBe('s7');
    expect(getLastOpenedSession('u1')).toBe('s7');
    expect(getLastOpenedSession('u2')).toBeNull();
  });

  it('reads an absent or corrupt mirror as no record', async () => {
    expect(getLastOpenedSessionSnapshot()).toBeNull();

    store.set(KEY, 'not json');
    await _hydrateLastOpenedSessionForTests();
    expect(getLastOpenedSessionSnapshot()).toBeNull();

    store.set(KEY, JSON.stringify({ sessionId: 's1', userId: 'u1' }));
    await _hydrateLastOpenedSessionForTests();
    expect(getLastOpenedSessionSnapshot()).toBeNull();
    expect(getLastOpenedSession('u1')).toBeNull();
  });

  it('notifies subscribers on record, restore, and clear, and stops after unsubscribe', async () => {
    store.set(KEY, recordFor('s7', 'u1'));
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeLastOpenedSession(listener);

    await _hydrateLastOpenedSessionForTests();
    expect(listener).toHaveBeenCalledOnce();

    listener.mockClear();
    recordLastOpenedSession('s8', 'u1');
    expect(listener).toHaveBeenCalledOnce();

    listener.mockClear();
    clearLastOpenedSession();
    expect(listener).toHaveBeenCalledOnce();

    listener.mockClear();
    recordLastOpenedSession('s9', 'u1');
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    listener.mockClear();
    recordLastOpenedSession('s10', 'u1');
    expect(listener).not.toHaveBeenCalled();
  });

  it('clears both memory and the SecureStore mirror', async () => {
    recordLastOpenedSession('s1', 'u1');

    clearLastOpenedSession();

    expect(getLastOpenedSessionSnapshot()).toBeNull();
    expect(getLastOpenedSession('u1')).toBeNull();

    await flushMirror();
    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(store.has(KEY)).toBe(false);
  });

  it('does not let a sign-out delete be overtaken by an in-flight write', async () => {
    // Hold the first mirror write open across the sign-out clear.
    const gate = deferred();
    secureStoreMock.setItemAsync.mockImplementationOnce(async (key: string, value: string) => {
      await gate.promise;
      store.set(key, value);
    });

    recordLastOpenedSession('s1', 'u1');
    clearLastOpenedSession();

    gate.resolve();
    await flushMirror();

    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(store.has(KEY)).toBe(false);
  });

  it('settles rapid mirror writes in order, so the last record wins', async () => {
    // The first write settles only after the second one is queued.
    const gate = deferred();
    secureStoreMock.setItemAsync.mockImplementationOnce(async (key: string, value: string) => {
      await gate.promise;
      store.set(key, value);
    });

    recordLastOpenedSession('s1', 'u1');
    recordLastOpenedSession('s2', 'u1');

    gate.resolve();
    await flushMirror();

    expect(JSON.parse(store.get(KEY) ?? '')).toMatchObject({ sessionId: 's2', userId: 'u1' });
  });

  it('does not overwrite a record held in memory before the restart read', async () => {
    store.set(KEY, recordFor('stale', 'u1'));
    const current: LastOpenedSessionRecord = {
      sessionId: 'fresh',
      userId: 'u1',
      storedAt: 1_800_000_000_000,
    };
    _setLastOpenedSessionForTests(current);

    await _hydrateLastOpenedSessionForTests();

    expect(getLastOpenedSessionSnapshot()).toBe('fresh');
    expect(getLastOpenedSession('u1')).toBe('fresh');
  });

  it('keeps a record written while the restart read is pending over the stale mirror', async () => {
    store.set(KEY, recordFor('stale', 'u1'));

    // Hold the restart read open so a live write can land mid-read.
    const gate = deferred();
    secureStoreMock.getItemAsync.mockImplementationOnce(async () => {
      await gate.promise;
      return recordFor('stale', 'u1');
    });

    const hydrationPromise = _hydrateLastOpenedSessionForTests();
    recordLastOpenedSession('fresh', 'u1');

    gate.resolve();
    await hydrationPromise;

    expect(getLastOpenedSession('u1')).toBe('fresh');
    expect(getLastOpenedSessionSnapshot()).toBe('fresh');
  });

  it('does not restore a record after a clear that lands mid-read', async () => {
    const staleRaw = recordFor('stale', 'u1');
    store.set(KEY, staleRaw);

    const gate = deferred();
    secureStoreMock.getItemAsync.mockImplementationOnce(async () => {
      await gate.promise;
      return staleRaw;
    });

    const hydrationPromise = _hydrateLastOpenedSessionForTests();
    clearLastOpenedSession();

    gate.resolve();
    await hydrationPromise;

    expect(getLastOpenedSessionSnapshot()).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });
});
