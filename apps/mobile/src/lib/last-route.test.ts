/* eslint-disable max-lines -- one suite for the restart-read store: the record, the repair latch, and the retry arms share one SecureStore fixture and one controllable AppState, so a second file would duplicate the harness */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setProtectedDataAvailable } from '@/lib/protected-data';

import {
  _hydrateLastRouteForTests,
  _resetLastRouteForTests,
  _setAppStateForTests,
  _setLastRouteForTests,
  _setSecureStoreForTests,
  clearLastRoute,
  consumeLastRouteForRepair,
  consumeRestoredRouteOpen,
  getLastRoute,
  getLastRouteSnapshot,
  isLastRouteHydrated,
  isLastRouteReadSettled,
  type LastRouteRecord,
  noteRestoredRouteOpen,
  prepareLastRouteRepair,
  recordLastRoute,
  subscribeLastRoute,
} from './last-route';

// The read failure is asserted through its one report, so the telemetry sink
// stays out of the suite.
const secureStoreReports = vi.hoisted(() => ({ report: vi.fn() }));

vi.mock('@/lib/telemetry/secure-store-events', () => ({
  reportSecureStoreFailure: secureStoreReports.report,
}));

// A controllable `AppState`, injected through the store's own test seam so the
// suite never loads react-native.
const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    listeners,
    addEventListener: vi.fn((_type: 'change', listener: (state: string) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    }),
    emit(state: string): void {
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
});

const KEY = 'last-route';

const store = new Map<string, string>();

// The refusal the next reads see; null lets the fake store answer.
let readRefusal: Error | null = null;

// Fake SecureStore surface backed by an in-memory Map, injected through the
// test-only setter so the durable mirror never loads the real native module.
const secureStoreMock = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  }),
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    if (readRefusal !== null) {
      throw readRefusal;
    }
    return store.get(key) ?? null;
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
    await Promise.resolve();
  }),
};

function recordFor(href: string, userId: string): string {
  return JSON.stringify({ href, userId, storedAt: 1_700_000_000_000 });
}

/**
 * Let the serialized SecureStore mirror drain. The mock operations settle in
 * microtasks, and the mirror chain awaits its predecessor, so one macrotask
 * boundary runs the whole chain.
 */
async function flushMirror(): Promise<void> {
  await new Promise<undefined>(resolve => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  store.clear();
  readRefusal = null;
  secureStoreMock.setItemAsync.mockClear();
  secureStoreMock.getItemAsync.mockClear();
  secureStoreMock.deleteItemAsync.mockClear();
  secureStoreReports.report.mockClear();
  appState.listeners.clear();
  appState.addEventListener.mockClear();
  _resetLastRouteForTests();
  _setSecureStoreForTests(secureStoreMock);
  _setAppStateForTests(appState);
});

afterEach(() => {
  vi.useRealTimers();
  setProtectedDataAvailable(true);
  _resetLastRouteForTests();
  _setSecureStoreForTests(null);
});

describe('recordLastRoute', () => {
  it('records the href for the signed-in account and mirrors it', async () => {
    // The layout's repair consumes (and latches) before any write is accepted.
    consumeLastRouteForRepair('u1');
    recordLastRoute('/(app)/(tabs)/(3_profile)/profiles/p1/variables', 'u1');
    await flushMirror();

    expect(getLastRoute('u1')).toBe('/(app)/(tabs)/(3_profile)/profiles/p1/variables');
    expect(store.get(KEY)).toBeTypeOf('string');
  });

  it('records nothing while signed out', () => {
    recordLastRoute('/(app)', null);
    expect(getLastRouteSnapshot()).toBeNull();
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled();
  });

  it('records nothing for an empty href', () => {
    consumeLastRouteForRepair('u1');
    recordLastRoute('', 'u1');
    expect(getLastRouteSnapshot()).toBeNull();
  });

  it('a later record wins and lands after the earlier mirror write', async () => {
    consumeLastRouteForRepair('u1');
    recordLastRoute('/(app)/a', 'u1');
    recordLastRoute('/(app)/b', 'u1');
    await flushMirror();

    expect(getLastRoute('u1')).toBe('/(app)/b');
    const mirrored = JSON.parse(store.get(KEY) ?? '{}') as LastRouteRecord;
    expect(mirrored.href).toBe('/(app)/b');
    expect(mirrored.userId).toBe('u1');
  });
});

describe('hydration state', () => {
  it('is not hydrated before the restart read settles', () => {
    _resetLastRouteForTests();
    expect(isLastRouteHydrated()).toBe(false);
  });

  it('is hydrated after the restart read settles on an absent mirror', async () => {
    await _hydrateLastRouteForTests();
    expect(isLastRouteHydrated()).toBe(true);
  });

  it('is hydrated after the restart read settles on a stored record', async () => {
    store.set(KEY, recordFor('/(app)/a', 'u1'));
    await _hydrateLastRouteForTests();
    expect(isLastRouteHydrated()).toBe(true);
    expect(getLastRoute('u1')).toBe('/(app)/a');
  });

  it('is not hydrated when the mirror read fails, and settles after the budget', async () => {
    vi.useFakeTimers();
    readRefusal = new Error('locked');
    await _hydrateLastRouteForTests();

    // A refused read is not "no record", so the launch must not settle on it.
    expect(isLastRouteHydrated()).toBe(false);
    expect(isLastRouteReadSettled()).toBe(false);

    await vi.advanceTimersByTimeAsync(250 + 500 + 1000);

    // The budget is spent, so the launch may settle, but the read never
    // answered: nothing is hydrated.
    expect(isLastRouteHydrated()).toBe(false);
    expect(isLastRouteReadSettled()).toBe(true);
    expect(getLastRouteSnapshot()).toBeNull();
    expect(secureStoreReports.report).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers when hydration settles', async () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeLastRoute(listener);
    await _hydrateLastRouteForTests();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});

describe('a restart read that refuses', () => {
  it('restores the record on the first retry', async () => {
    vi.useFakeTimers();
    store.set(KEY, recordFor('/(app)/variables', 'u1'));
    readRefusal = new Error('keychain busy');

    await _hydrateLastRouteForTests();

    expect(isLastRouteHydrated()).toBe(false);
    expect(isLastRouteReadSettled()).toBe(false);
    // The repair has no answer to read, and its latch stays open so recording
    // stays held: the cold start's route cannot overwrite the stored record.
    expect(consumeLastRouteForRepair('u1')).toBeNull();
    expect(recordLastRoute('/(app)/(tabs)/(0_home)', 'u1')).toBe(false);
    expect(store.get(KEY)).toBe(recordFor('/(app)/variables', 'u1'));

    // The first backoff step (250 ms) runs the read that answers.
    readRefusal = null;
    await vi.advanceTimersByTimeAsync(250);

    expect(getLastRoute('u1')).toBe('/(app)/variables');
    expect(isLastRouteHydrated()).toBe(true);
    expect(isLastRouteReadSettled()).toBe(true);
    expect(consumeLastRouteForRepair('u1')).toBe('/(app)/variables');
  });

  it('settles the launch without latching after the budget is spent', async () => {
    vi.useFakeTimers();
    store.set(KEY, recordFor('/(app)/variables', 'u1'));
    readRefusal = new Error('keychain unavailable');

    await _hydrateLastRouteForTests();
    expect(isLastRouteReadSettled()).toBe(false);

    // 250 + 500 + 1000 ms: three retries after the first read.
    await vi.advanceTimersByTimeAsync(250 + 500 + 1000);

    expect(isLastRouteHydrated()).toBe(false);
    expect(isLastRouteReadSettled()).toBe(true);
    // The repair never latched, so the recorder still holds writes and the
    // mirror keeps the record the launch could not read.
    expect(consumeLastRouteForRepair('u1')).toBeNull();
    expect(recordLastRoute('/(app)/(tabs)/(0_home)', 'u1')).toBe(false);
    expect(store.get(KEY)).toBe(recordFor('/(app)/variables', 'u1'));
    expect(secureStoreReports.report).toHaveBeenCalledTimes(1);

    // A later read that fails again is silent: the launch already settled, so
    // a further refusal must not notify the layout again.
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeLastRoute(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).not.toHaveBeenCalled();
    expect(secureStoreReports.report).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('a resume retry answers after the budget is spent', async () => {
    vi.useFakeTimers();
    store.set(KEY, recordFor('/(app)/variables', 'u1'));
    readRefusal = new Error('keychain unavailable');

    await _hydrateLastRouteForTests();
    await vi.advanceTimersByTimeAsync(250 + 500 + 1000);
    expect(isLastRouteReadSettled()).toBe(true);
    expect(isLastRouteHydrated()).toBe(false);

    readRefusal = null;
    appState.emit('active');
    await vi.advanceTimersByTimeAsync(0);

    expect(isLastRouteHydrated()).toBe(true);
    expect(getLastRoute('u1')).toBe('/(app)/variables');
    expect(consumeLastRouteForRepair('u1')).toBe('/(app)/variables');
    // The repair latched on the answer, so recording opens.
    expect(recordLastRoute('/(app)/(tabs)/(0_home)', 'u1')).toBe(true);
  });

  it('settles again after a lock clears and the re-read spends the budget', async () => {
    vi.useFakeTimers();
    store.set(KEY, recordFor('/(app)/variables', 'u1'));
    setProtectedDataAvailable(false);
    readRefusal = new Error('keychain unavailable');

    await _hydrateLastRouteForTests();

    // A locked device spends no attempt: the launch settles without an answer
    // and the unlock retry owns the next read.
    expect(isLastRouteReadSettled()).toBe(true);
    expect(isLastRouteHydrated()).toBe(false);
    expect(secureStoreReports.report).not.toHaveBeenCalled();

    // The unlock fires, and now the store refuses for a real reason: the read
    // spends the whole budget and must leave a settled state, not the pending
    // one it was in while reading.
    setProtectedDataAvailable(true);
    await vi.advanceTimersByTimeAsync(250 + 500 + 1000);

    expect(isLastRouteReadSettled()).toBe(true);
    expect(isLastRouteHydrated()).toBe(false);
    expect(secureStoreReports.report).toHaveBeenCalledTimes(1);
  });

  it('keeps the launch path working after an exhausted state re-reads and fails again', async () => {
    vi.useFakeTimers();
    store.set(KEY, recordFor('/(app)/variables', 'u1'));
    readRefusal = new Error('keychain unavailable');

    await _hydrateLastRouteForTests();
    await vi.advanceTimersByTimeAsync(250 + 500 + 1000);
    expect(isLastRouteReadSettled()).toBe(true);
    expect(secureStoreReports.report).toHaveBeenCalledTimes(1);

    // The resume retry is armed while failed; its re-read fails again, so the
    // state must stay settled, stay silent, and stay unlatched.
    appState.emit('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(isLastRouteReadSettled()).toBe(true);
    expect(isLastRouteHydrated()).toBe(false);
    expect(secureStoreReports.report).toHaveBeenCalledTimes(1);
    expect(consumeLastRouteForRepair('u1')).toBeNull();
    expect(recordLastRoute('/(app)/(tabs)/(0_home)', 'u1')).toBe(false);
    expect(store.get(KEY)).toBe(recordFor('/(app)/variables', 'u1'));

    // The failed re-read armed the resume retry again, so the next resume with
    // a working store answers and the whole launch path opens up.
    readRefusal = null;
    appState.emit('active');
    await vi.advanceTimersByTimeAsync(0);

    expect(isLastRouteHydrated()).toBe(true);
    expect(getLastRoute('u1')).toBe('/(app)/variables');
    expect(consumeLastRouteForRepair('u1')).toBe('/(app)/variables');
    expect(recordLastRoute('/(app)/(tabs)/(0_home)', 'u1')).toBe(true);
  });
});

describe('consumeLastRouteForRepair', () => {
  it('keeps the focused profile route while root Retry remounts at Home', () => {
    const profileRoute = '/(app)/(tabs)/(3_profile)/profiles/new';
    consumeLastRouteForRepair('u1');
    recordLastRoute(profileRoute, 'u1');

    prepareLastRouteRepair();
    expect(recordLastRoute('/(app)/(tabs)/(0_home)', 'u1')).toBe(false);
    expect(consumeLastRouteForRepair('other-account')).toBeNull();
    expect(consumeLastRouteForRepair('u1')).toBe(profileRoute);

    expect(recordLastRoute('/(app)/(tabs)/(0_home)', 'u1')).toBe(true);
    expect(getLastRoute('u1')).toBe('/(app)/(tabs)/(0_home)');
  });

  it('keeps returning the record; the caller latches the repair once', async () => {
    store.set(KEY, recordFor('/(app)/variables', 'u1'));
    await _hydrateLastRouteForTests();

    expect(consumeLastRouteForRepair('u1')).toBe('/(app)/variables');
    // The repair-once latch lives in the caller; the store keeps the record.
    expect(consumeLastRouteForRepair('u1')).toBe('/(app)/variables');
  });

  it('returns null for a record owned by another account', async () => {
    store.set(KEY, recordFor('/(app)/variables', 'someone-else'));
    await _hydrateLastRouteForTests();

    expect(consumeLastRouteForRepair('u1')).toBeNull();
  });

  it('opens recording from then on', async () => {
    store.set(KEY, recordFor('/(app)/variables', 'u1'));
    await _hydrateLastRouteForTests();

    consumeLastRouteForRepair('u1');
    recordLastRoute('/(app)/(tabs)/(0_home)', 'u1');
    expect(getLastRoute('u1')).toBe('/(app)/(tabs)/(0_home)');
  });

  it('holds recording before the repair consumed the record', async () => {
    store.set(KEY, recordFor('/(app)/variables', 'u1'));
    await _hydrateLastRouteForTests();

    // The cold start's first commit (the base Intent's restored route) must
    // not overwrite the persisted record before the repair reads it.
    recordLastRoute('/agent-chat/ses_stale', 'u1');
    expect(getLastRoute('u1')).toBe('/(app)/variables');
    expect(consumeLastRouteForRepair('u1')).toBe('/(app)/variables');
  });
});

describe('consumeRestoredRouteOpen', () => {
  it('marks the route the repair opened, groups and query included', () => {
    noteRestoredRouteOpen('/(app)/agent-chat/ses_1?at=msg_2');

    expect(consumeRestoredRouteOpen('/agent-chat/ses_1')).toBe(true);
  });

  it('is one-shot, so a later open of the same route answers for itself', () => {
    noteRestoredRouteOpen('/(app)/agent-chat/ses_1');
    expect(consumeRestoredRouteOpen('/agent-chat/ses_1')).toBe(true);

    expect(consumeRestoredRouteOpen('/agent-chat/ses_1')).toBe(false);
  });

  it('does not mark a different route, and the next route is unmarked', () => {
    noteRestoredRouteOpen('/(app)/agent-chat/ses_1');

    expect(consumeRestoredRouteOpen('/(app)/(tabs)/(0_home)')).toBe(false);
    expect(consumeRestoredRouteOpen('/agent-chat/ses_1')).toBe(false);
  });

  it('marks nothing when no restore ran', () => {
    expect(consumeRestoredRouteOpen('/agent-chat/ses_1')).toBe(false);
  });
});

describe('getLastRoute', () => {
  it('returns null for a record owned by another account', () => {
    _setLastRouteForTests({
      href: '/(app)/a',
      userId: 'someone-else',
      storedAt: 1,
    });
    expect(getLastRoute('u1')).toBeNull();
  });

  it('returns null without a user id', () => {
    consumeLastRouteForRepair(null);
    recordLastRoute('/(app)/a', 'u1');
    expect(getLastRoute(null)).toBeNull();
  });
});

describe('subscribeLastRoute (the restart read)', () => {
  it('rehydrates the mirrored record on subscribe', async () => {
    store.set(KEY, recordFor('/(app)/variables', 'u1'));
    await _hydrateLastRouteForTests();

    expect(getLastRoute('u1')).toBe('/(app)/variables');
  });

  it('a corrupt mirror reads as absent', async () => {
    store.set(KEY, '{not json');
    await _hydrateLastRouteForTests();

    expect(getLastRouteSnapshot()).toBeNull();
  });

  it('a mirrored route pattern reads as absent', async () => {
    store.set(KEY, recordFor('/(app)/(tabs)/(3_profile)/profiles/[profileId]/variables', 'u1'));
    await _hydrateLastRouteForTests();

    expect(getLastRouteSnapshot()).toBeNull();
    expect(getLastRoute('u1')).toBeNull();
    expect(consumeLastRouteForRepair('u1')).toBeNull();
  });

  it('a mirrored picker route reads as absent', async () => {
    // A build before pickers were excluded could persist the sheet that was on
    // top. Replaying it reopens the expired shell over the start route, with no
    // screen behind it to reopen the picker from.
    store.set(KEY, recordFor('/(app)/agent-chat/repo-picker', 'u1'));
    await _hydrateLastRouteForTests();

    expect(getLastRouteSnapshot()).toBeNull();
    expect(getLastRoute('u1')).toBeNull();
    expect(consumeLastRouteForRepair('u1')).toBeNull();
  });

  it.each([
    [
      '/(app)/(tabs)/(3_profile)/code-reviewer/personal/reviews',
      '/(app)/code-reviewer/personal/reviews',
    ],
    [
      '/(app)/(tabs)/(3_profile)/security-agent/org-1/findings/f_1',
      '/(app)/security-agent/org-1/findings/f_1',
    ],
    ['/(app)/(tabs)/(3_profile)/notifications', '/(app)/notifications'],
    ['/(app)/device-sessions', '/(app)/(tabs)/(3_profile)/device-sessions'],
  ])('rehydrates a %s record at the path the screen has now', async (stored, current) => {
    // Mirrored before these surfaces moved: replaying the old href after the
    // update opens an unmatched route, so the record is read at the screen's
    // current path.
    store.set(KEY, recordFor(stored, 'u1'));
    await _hydrateLastRouteForTests();

    expect(getLastRoute('u1')).toBe(current);
  });

  it('a record written during the restart read owns the state', async () => {
    const gate = Promise.withResolvers<undefined>();
    secureStoreMock.getItemAsync.mockImplementationOnce(async () => {
      await gate.promise;
      return recordFor('/(app)/from-mirror', 'u1');
    });
    const hydrationPromise = _hydrateLastRouteForTests();

    // A write before the repair consumed the mirror record is dropped: on a
    // cold start that write would be the base Intent's restored route.
    recordLastRoute('/(app)/live', 'u1');
    gate.resolve(undefined);
    await hydrationPromise;

    expect(getLastRoute('u1')).toBe('/(app)/from-mirror');
  });

  it('a clear during the restart read keeps the record dropped', async () => {
    const gate = Promise.withResolvers<undefined>();
    secureStoreMock.getItemAsync.mockImplementationOnce(async () => {
      await gate.promise;
      return recordFor('/(app)/from-mirror', 'u1');
    });
    const hydrationPromise = _hydrateLastRouteForTests();

    clearLastRoute();
    gate.resolve(undefined);
    await hydrationPromise;

    expect(getLastRouteSnapshot()).toBeNull();
  });

  it('stops notifying an unsubscribed listener', () => {
    consumeLastRouteForRepair('u1');
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeLastRoute(listener);
    unsubscribe();

    expect(recordLastRoute('/(app)/a', 'u1')).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('a foreign-account record is not offered after rehydrate', async () => {
    store.set(KEY, recordFor('/(app)/a', 'former-user'));
    await _hydrateLastRouteForTests();

    expect(getLastRoute('u1')).toBeNull();
    // And the snapshot still names the stored value: callers decide by id.
    expect(getLastRouteSnapshot()?.userId).toBe('former-user');
  });
});

describe('clearLastRoute', () => {
  it('drops the in-memory record and the mirror', async () => {
    recordLastRoute('/(app)/a', 'u1');
    await flushMirror();

    clearLastRoute();
    await flushMirror();

    expect(getLastRouteSnapshot()).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });
});

describe('record shape', () => {
  it('records the href, the account and a timestamp through the write path', () => {
    consumeLastRouteForRepair('u1');
    recordLastRoute('/(app)/(tabs)/(0_home)', 'u1');

    const snapshot = getLastRouteSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.href).toBe('/(app)/(tabs)/(0_home)');
    expect(snapshot?.userId).toBe('u1');
    expect(snapshot?.storedAt).toBeTypeOf('number');
    expect(getLastRoute('u1')).toBe('/(app)/(tabs)/(0_home)');
  });

  it('hydrates the href, the account and a timestamp off the mirror', async () => {
    store.set(KEY, recordFor('/(app)/(tabs)/(0_home)', 'u1'));
    await _hydrateLastRouteForTests();

    const snapshot = getLastRouteSnapshot();
    expect(snapshot?.href).toBe('/(app)/(tabs)/(0_home)');
    expect(snapshot?.userId).toBe('u1');
    expect(snapshot?.storedAt).toBeTypeOf('number');
  });
});
