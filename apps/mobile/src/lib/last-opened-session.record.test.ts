import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deferred,
  flushMirror,
  installHealthyStore,
  KEY,
  recordFor,
  store,
} from './last-opened-session.test-helpers';
import {
  _hydrateLastOpenedSessionForTests,
  _resetLastOpenedSessionForTests,
  _setLastOpenedSessionForTests,
  clearLastOpenedSession,
  getLastOpenedSession,
  getLastOpenedSessionSnapshot,
  type LastOpenedSessionRecord,
  recordLastOpenedSession,
  subscribeLastOpenedSession,
} from './last-opened-session';

// The fake SecureStore surface must be hoisted in this file, so it stays here
// rather than in the helpers module.
const getItemAsync = vi.hoisted(() => vi.fn<(key: string) => Promise<string | null>>());
const setItemAsync = vi.hoisted(() => vi.fn<(key: string, value: string) => Promise<void>>());
const deleteItemAsync = vi.hoisted(() => vi.fn<(key: string) => Promise<void>>());

vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));
// The retry helper reads the bundle-time fault window; the app build's `extra`
// cannot load under Vitest, and this suite drives its own refusals.
vi.mock('@/lib/config', () => ({ E2E_SECURE_STORE_FAULT_MS: 0 }));

beforeEach(() => {
  vi.useFakeTimers();
  _resetLastOpenedSessionForTests();
  installHealthyStore({ getItemAsync, setItemAsync, deleteItemAsync });
});

afterEach(() => {
  _resetLastOpenedSessionForTests();
  store.clear();
  vi.useRealTimers();
});

describe('last opened session record', () => {
  it('records the session for its account and mirrors the exact record shape', async () => {
    recordLastOpenedSession('s1', 'u1');

    expect(getLastOpenedSession('u1')).toBe('s1');
    expect(getLastOpenedSessionSnapshot()).toBe('s1');

    await flushMirror();
    expect(setItemAsync).toHaveBeenCalledOnce();
    expect(setItemAsync.mock.calls[0]?.[0]).toBe(KEY);
    expect(JSON.parse(setItemAsync.mock.calls[0]?.[1] ?? '')).toEqual({
      sessionId: 's1',
      userId: 'u1',
      storedAt: expect.any(Number),
    });
  });

  it('records nothing without a signed-in account', () => {
    recordLastOpenedSession('s1', null);

    expect(getLastOpenedSessionSnapshot()).toBeNull();
    expect(getLastOpenedSession(null)).toBeNull();
    expect(setItemAsync).not.toHaveBeenCalled();
  });

  it('never offers one account the session recorded for another', () => {
    recordLastOpenedSession('s1', 'u1');

    expect(getLastOpenedSession('u2')).toBeNull();
    expect(getLastOpenedSession(null)).toBeNull();
    expect(getLastOpenedSession('u1')).toBe('s1');
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
    expect(deleteItemAsync).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(store.has(KEY)).toBe(false);
  });

  it('does not let a sign-out delete be overtaken by an in-flight write', async () => {
    // Hold the first mirror write open across the sign-out clear.
    const gate = deferred();
    setItemAsync.mockImplementationOnce(async (key: string, value: string) => {
      await gate.promise;
      store.set(key, value);
    });

    recordLastOpenedSession('s1', 'u1');
    clearLastOpenedSession();

    gate.resolve();
    await flushMirror();

    expect(deleteItemAsync).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(store.has(KEY)).toBe(false);
  });

  it('settles rapid mirror writes in order, so the last record wins', async () => {
    // The first write settles only after the second one is queued.
    const gate = deferred();
    setItemAsync.mockImplementationOnce(async (key: string, value: string) => {
      await gate.promise;
      store.set(key, value);
    });

    recordLastOpenedSession('s1', 'u1');
    recordLastOpenedSession('s2', 'u1');

    gate.resolve();
    await flushMirror();

    expect(JSON.parse(store.get(KEY) ?? '')).toMatchObject({ sessionId: 's2', userId: 'u1' });
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
});
