import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveLauncherTargets } from './launcher-surfaces';
import { setProtectedDataAvailable } from './protected-data';
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

const KEY = 'last-opened-session';

// Fake SecureStore surface backed by an in-memory Map. The module reads and
// writes through the shared keychain helpers, so the native module is mocked
// here instead of injected.
const getItemAsync = vi.hoisted(() => vi.fn<(key: string) => Promise<string | null>>());
const setItemAsync = vi.hoisted(() => vi.fn<(key: string, value: string) => Promise<void>>());
const deleteItemAsync = vi.hoisted(() => vi.fn<(key: string) => Promise<void>>());

vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));
// The retry helper reads the bundle-time fault window; the app build's `extra`
// cannot load under Vitest, and this suite drives its own refusals.
vi.mock('@/lib/config', () => ({ E2E_SECURE_STORE_FAULT_MS: 0 }));

const store = new Map<string, string>();

function recordFor(sessionId: string, userId: string): string {
  return JSON.stringify({ sessionId, userId, storedAt: 1_700_000_000_000 });
}

/** A read that rejects, built without `Promise.reject` so the promise rule
 *  stays satisfied. */
// eslint-disable-next-line require-await -- an async throw is the rejected promise under test
async function refusedRead(message: string): Promise<string | null> {
  throw new Error(message);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return {
    promise,
    resolve: () => {
      resolve(undefined);
    },
  };
}

/**
 * Let the serialized SecureStore mirror drain and the retry cadence land: the
 * mock operations settle in microtasks, and the retry backoff is a timer.
 */
async function flushMirror(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

/** Run the whole retry budget (250 + 500 + 1000 ms plus the reads between). */
async function flushRetryBudget(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetLastOpenedSessionForTests();
  store.clear();
  vi.clearAllMocks();
  getItemAsync.mockImplementation(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  });
  setItemAsync.mockImplementation(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  });
  deleteItemAsync.mockImplementation(async (key: string) => {
    store.delete(key);
    await Promise.resolve();
  });
});

afterEach(() => {
  _resetLastOpenedSessionForTests();
  store.clear();
  vi.useRealTimers();
});

describe('last opened session', () => {
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
    getItemAsync.mockImplementationOnce(async () => {
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
    getItemAsync.mockImplementationOnce(async () => {
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

  it('offers the session once a refused first read is retried successfully', async () => {
    store.set(KEY, recordFor('s7', 'u1'));
    getItemAsync.mockImplementationOnce(() => refusedRead('keychain unavailable'));
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeLastOpenedSession(listener);

    // The first read of the budget is refused; the retry after the backoff
    // answers with the mirrored record.
    expect(getLastOpenedSession('u1')).toBeNull();
    await flushRetryBudget();

    expect(getItemAsync).toHaveBeenCalledTimes(2);
    expect(getLastOpenedSession('u1')).toBe('s7');
    expect(getLastOpenedSessionSnapshot()).toBe('s7');
    expect(listener).toHaveBeenCalled();
    // The launcher surface the read feeds now offers the session.
    expect(
      deriveLauncherTargets({ waiting: [], lastOpenedSessionId: getLastOpenedSession('u1') })
        .openLastSessionUrl
    ).toBe('kiloapp:///cloud/sessions/s7');
    unsubscribe();
  });

  it('does not cache a spent read budget, so the next reader answers the record', async () => {
    store.set(KEY, recordFor('s7', 'u1'));
    getItemAsync.mockImplementation(() => refusedRead('keychain unavailable'));

    expect(getLastOpenedSession('u1')).toBeNull();
    await flushRetryBudget();

    // Four attempts is the whole budget, and the absence they left is not the
    // mirror's answer: this run keeps no cached hydration for it.
    expect(getItemAsync).toHaveBeenCalledTimes(4);
    expect(getLastOpenedSessionSnapshot()).toBeNull();

    // The keychain answers again. The next reader reads once and restores the
    // record: the spent budget did not become this run's answer.
    getItemAsync.mockImplementation(async (key: string) => {
      await Promise.resolve();
      return store.get(key) ?? null;
    });

    expect(getLastOpenedSession('u1')).toBeNull();
    await flushMirror();

    expect(getLastOpenedSession('u1')).toBe('s7');
    expect(getLastOpenedSessionSnapshot()).toBe('s7');
    expect(getItemAsync).toHaveBeenCalledTimes(5);
  });

  it('keeps a read that answered no record for the run', async () => {
    expect(getLastOpenedSession('u1')).toBeNull();
    await flushMirror();
    expect(getItemAsync).toHaveBeenCalledTimes(1);

    // Nothing stored is the answer: this run does not ask the keychain again.
    expect(getLastOpenedSession('u1')).toBeNull();
    expect(getLastOpenedSessionSnapshot()).toBeNull();
    getLastOpenedSession('u2');
    await flushMirror();

    expect(getItemAsync).toHaveBeenCalledTimes(1);
  });

  it('reports one failure however many readers a broken keychain meets', async () => {
    const { setTelemetrySink } = await import('@/lib/telemetry/error-sink');
    const events: { fingerprint?: readonly string[] }[] = [];
    setTelemetrySink(event => {
      events.push(event);
    });
    try {
      store.set(KEY, recordFor('s7', 'u1'));
      getItemAsync.mockImplementation(() => refusedRead('keychain unavailable'));

      // The first reader spends the reported budget.
      expect(getLastOpenedSession('u1')).toBeNull();
      await flushRetryBudget();
      expect(getItemAsync).toHaveBeenCalledTimes(4);

      // Every later reader — the launcher mount re-reads on each render — tries
      // once and stays silent, so one broken keychain is one event.
      expect(getLastOpenedSession('u1')).toBeNull();
      await flushMirror();
      expect(getLastOpenedSession('u1')).toBeNull();
      await flushMirror();
      expect(getLastOpenedSession('u1')).toBeNull();
      await flushMirror();
      expect(getItemAsync).toHaveBeenCalledTimes(7);

      expect(events).toHaveLength(1);
      expect(events[0]?.fingerprint).toEqual(['secure-store-failure', 'read']);
    } finally {
      setTelemetrySink(null);
    }
  });

  it('reads again at the unlock when the device refused the read while locked', async () => {
    store.set(KEY, recordFor('s7', 'u1'));

    setProtectedDataAvailable(false);
    try {
      // The mount subscribes on a device whose keychain is still closed. A
      // locked device refuses the guard before the store, so the read costs no
      // keychain call and files no failure.
      const listener = vi.fn<() => void>();
      const unsubscribe = subscribeLastOpenedSession(listener);
      await flushRetryBudget();
      expect(getItemAsync).not.toHaveBeenCalled();
      expect(getLastOpenedSessionSnapshot()).toBeNull();

      // The unlock is the answer becoming readable: the armed re-read restores
      // the record and re-renders the subscriber.
      setProtectedDataAvailable(true);
      await flushMirror();

      expect(getItemAsync).toHaveBeenCalledOnce();
      expect(getLastOpenedSession('u1')).toBe('s7');
      expect(getLastOpenedSessionSnapshot()).toBe('s7');
      expect(listener).toHaveBeenCalled();
      unsubscribe();
    } finally {
      setProtectedDataAvailable(true);
    }
  });
});
