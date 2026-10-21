import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _hydrateLastRouteForTests,
  _resetLastRouteForTests,
  _setLastRouteForTests,
  _setSecureStoreForTests,
  clearLastRoute,
  consumeLastRouteForRepair,
  getLastRoute,
  getLastRouteSnapshot,
  isLastRouteHydrated,
  type LastRouteRecord,
  recordLastRoute,
  subscribeLastRoute,
} from './last-route';

const KEY = 'last-route';

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
  secureStoreMock.setItemAsync.mockClear();
  secureStoreMock.getItemAsync.mockClear();
  secureStoreMock.deleteItemAsync.mockClear();
  _resetLastRouteForTests();
  _setSecureStoreForTests(secureStoreMock);
});

afterEach(() => {
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

  it('is hydrated when the mirror read fails', async () => {
    secureStoreMock.getItemAsync.mockRejectedValueOnce(new Error('locked'));
    await _hydrateLastRouteForTests();
    expect(isLastRouteHydrated()).toBe(true);
    expect(getLastRouteSnapshot()).toBeNull();
  });

  it('notifies subscribers when hydration settles', async () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeLastRoute(listener);
    await _hydrateLastRouteForTests();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});

describe('consumeLastRouteForRepair', () => {
  it('returns the record once, then null', async () => {
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
    // Written before hrefs were concrete: the segment list carried the
    // `[profileId]` route pattern, and restoring it opens a screen whose data
    // reads cannot resolve.
    store.set(
      KEY,
      recordFor('/(app)/(tabs)/(3_profile)/profiles/[profileId]/variables', 'u1')
    );
    await _hydrateLastRouteForTests();

    expect(getLastRouteSnapshot()).toBeNull();
    expect(getLastRoute('u1')).toBeNull();
    expect(consumeLastRouteForRepair('u1')).toBeNull();
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

  it('notifies subscribers on every record change', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeLastRoute(listener);
    unsubscribe();

    recordLastRoute('/(app)/a', 'u1');
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
  it('carries the href, the account and a timestamp', () => {
    const record: LastRouteRecord = {
      href: '/(app)',
      userId: 'u1',
      storedAt: 5,
    };
    _setLastRouteForTests(record);
    expect(getLastRouteSnapshot()).toEqual(record);
  });
});
