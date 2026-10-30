/* eslint-disable max-lines -- one cohesive mirror suite: read fencing, write ordering, and the scope gate the mirror feeds */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { EMPTY_HOME_WIDGET_DETAILS } from '@kilocode/app-shared/home-widget';

import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';

import { getLastHomeWidgetData } from './home-widget-data';
import {
  _flushGlanceableMirrorForTests,
  _resetGlanceablePersistForTests,
  _setGlanceableRestoreUnavailableForTests,
  _setLastGlanceableSnapshotForTests,
  _setSecureStoreForTests,
  getLastGlanceableSnapshot,
  getLocalScopeKey,
  isGlanceableRestoreSettled,
  isGlanceableRestoreUnavailable,
  persistGlanceableSink,
  restorePersistedGlanceable,
  whenGlanceableRestoresSettle,
} from './persist';

const NOW = 1_750_000_000_000;
const SNAPSHOT_KEY = 'glanceable-snapshot';
const SCOPE_KEY = 'glanceable-scope-key';
const HOME_WIDGET_DATA_KEY = 'home-widget-data';
const details = EMPTY_HOME_WIDGET_DETAILS;

const store = new Map<string, string>();

// Fake SecureStore surface backed by an in-memory Map, injected through the
// test-only setter so the durable mirror never loads the real native module.
// The defaults are re-installed per case: a case that holds a write open must
// not leak its implementation into the next one.
const defaultSetItem = async (key: string, value: string) => {
  store.set(key, value);
  await Promise.resolve();
};

const defaultGetItem = async (key: string): Promise<string | null> => {
  await Promise.resolve();
  return store.get(key) ?? null;
};

const secureStoreMock = {
  setItemAsync: vi.fn(defaultSetItem),
  getItemAsync: vi.fn(defaultGetItem),
};

function snapshotFor(sessions: { status: string }[]): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
  });
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
 * A JS restart: a fresh module instance with no in-memory state reads the
 * SecureStore the previous process wrote. The dynamic import is the point:
 * a static import would keep the instance the test already published through,
 * so only a re-import after `resetModules` starts from an empty module state.
 */
async function restartPersistModule() {
  vi.resetModules();
  const fresh = await import('./persist');
  fresh._setSecureStoreForTests(secureStoreMock);
  return fresh;
}

beforeEach(() => {
  _resetGlanceablePersistForTests();
  _setSecureStoreForTests(secureStoreMock);
  store.clear();
  vi.clearAllMocks();
  secureStoreMock.setItemAsync.mockImplementation(defaultSetItem);
  secureStoreMock.getItemAsync.mockImplementation(defaultGetItem);
});

afterEach(async () => {
  // Let a queued mirror write land before the next case clears the map.
  await _flushGlanceableMirrorForTests();
  _resetGlanceablePersistForTests();
  store.clear();
});

describe('restorePersistedGlanceable', () => {
  it('does not clobber a snapshot written after the restore read started', async () => {
    const stale = snapshotFor([]);
    const staleRaw = JSON.stringify(stale);
    store.set(SNAPSHOT_KEY, staleRaw);
    store.set(SCOPE_KEY, 'stale-scope');

    // Hold the restore read open so a live publish can land mid-read.
    const gate = deferred();
    secureStoreMock.getItemAsync.mockImplementationOnce(async () => {
      await gate.promise;
      return staleRaw;
    });

    const restorePromise = restorePersistedGlanceable();

    // A live publish lands while the persisted read is still pending.
    const fresh = snapshotFor([{ status: 'busy' }]);
    persistGlanceableSink.publish(fresh);

    gate.resolve();
    await restorePromise;

    expect(getLastGlanceableSnapshot()).toEqual(fresh);
    expect(getLocalScopeKey()).toBe(fresh.scopeKey);
  });

  it('rejects a malformed stored record and keeps no snapshot', async () => {
    store.set(SNAPSHOT_KEY, JSON.stringify({ schemaVersion: 1, revision: 'nope' }));
    store.set(SCOPE_KEY, 'scope');

    await restorePersistedGlanceable();

    expect(getLastGlanceableSnapshot()).toBeNull();
  });

  it('does not clobber an in-memory state already set before the restore read', async () => {
    // A stale persisted record from a prior session sits on disk.
    const stale = snapshotFor([{ status: 'busy' }]);
    store.set(SNAPSHOT_KEY, JSON.stringify(stale));
    store.set(SCOPE_KEY, 'stale-scope');

    // A logout blank landed in memory before restore started (a remount, not a
    // JS restart). Its SecureStore mirror is not part of this test, so the
    // disk still holds the stale record.
    const blank = buildGlanceableSnapshot({
      sessions: [],
      userId: 'u1',
      organizationId: null,
      now: NOW,
      status: 'signed_out',
    });
    _setLastGlanceableSnapshotForTests(blank);

    await restorePersistedGlanceable();

    expect(getLastGlanceableSnapshot()).toEqual(blank);
    expect(getLocalScopeKey()).toBe(blank.scopeKey);
  });

  it('restores a schema-valid stored record', async () => {
    const stored = snapshotFor([{ status: 'busy' }]);
    store.set(SNAPSHOT_KEY, JSON.stringify(stored));
    store.set(SCOPE_KEY, stored.scopeKey);

    await restorePersistedGlanceable();

    expect(getLastGlanceableSnapshot()).toEqual(stored);
    expect(getLocalScopeKey()).toBe(stored.scopeKey);
    expect(isGlanceableRestoreUnavailable()).toBe(false);
  });

  it('flags an unreadable mirror so a caller can tell it from an absent record', async () => {
    // A locked keychain (expo-secure-store's default WHEN_UNLOCKED access): the
    // record may exist but cannot be read.
    secureStoreMock.getItemAsync.mockRejectedValueOnce(new Error('keychain locked'));

    await restorePersistedGlanceable();

    expect(getLastGlanceableSnapshot()).toBeNull();
    expect(isGlanceableRestoreUnavailable()).toBe(true);
    expect(isGlanceableRestoreSettled()).toBe(true);
  });

  it('does not report a restore settled until the first read finishes', async () => {
    const gate = deferred();
    secureStoreMock.getItemAsync.mockImplementationOnce(async () => {
      await gate.promise;
      return null;
    });

    const restore = restorePersistedGlanceable();

    // A caller that reads a null snapshot must not treat it as "nothing
    // persisted" until the read that could fill it has settled.
    expect(isGlanceableRestoreSettled()).toBe(false);

    gate.resolve();
    await restore;

    expect(isGlanceableRestoreSettled()).toBe(true);
  });

  it('reports a later in-flight read as unsettled, not only the first', async () => {
    // The first read settles with nothing on disk, so a caller would read the
    // null snapshot as "nothing persisted". A later read re-opens that window:
    // the record it is about to consult may still name a card owner.
    await restorePersistedGlanceable();
    expect(isGlanceableRestoreSettled()).toBe(true);

    const gate = deferred();
    secureStoreMock.getItemAsync.mockImplementationOnce(async () => {
      await gate.promise;
      return null;
    });

    const restore = restorePersistedGlanceable();

    expect(isGlanceableRestoreSettled()).toBe(false);

    gate.resolve();
    await restore;

    expect(isGlanceableRestoreSettled()).toBe(true);
  });

  it('resumes a waiter when the last in-flight read lands', async () => {
    await restorePersistedGlanceable();
    // Nothing in flight: a waiter parked after the fact resumes at once.
    await whenGlanceableRestoresSettle();

    const gate = deferred();
    secureStoreMock.getItemAsync.mockImplementationOnce(async () => {
      await gate.promise;
      return null;
    });
    const restore = restorePersistedGlanceable();

    let resumed = false;
    const waiting = (async () => {
      await whenGlanceableRestoresSettle();
      resumed = true;
    })();
    await Promise.resolve();
    expect(resumed).toBe(false);

    gate.resolve();
    await restore;
    await waiting;

    expect(resumed).toBe(true);
  });

  it('resumes a waiter when a read that fails settles', async () => {
    const gate = deferred();
    secureStoreMock.getItemAsync.mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error('keychain locked');
    });
    const restore = restorePersistedGlanceable();

    let resumed = false;
    const waiting = (async () => {
      await whenGlanceableRestoresSettle();
      resumed = true;
    })();

    gate.resolve();
    await restore;
    await waiting;

    // The failure still settles the read, so the waiter resumes and reads the
    // unreadable flag itself.
    expect(resumed).toBe(true);
    expect(isGlanceableRestoreUnavailable()).toBe(true);
  });

  it('clears the unreadable flag after a read that succeeds', async () => {
    _setGlanceableRestoreUnavailableForTests(true);

    await restorePersistedGlanceable();

    expect(isGlanceableRestoreUnavailable()).toBe(false);
  });

  // The mirror written by the previous release at schema version 1 carries no
  // newest-result keys. Rejecting it would drop the last counts and scope key
  // of a widget that survived the app upgrade, so it restores with the fact
  // absent.
  it('restores a record written before the newest-result fields existed', async () => {
    const stored = snapshotFor([{ status: 'busy' }]);
    const { newestResultKind: _kind, newestResultAt: _at, ...previousRelease } = stored;
    store.set(SNAPSHOT_KEY, JSON.stringify(previousRelease));
    store.set(SCOPE_KEY, stored.scopeKey);

    await restorePersistedGlanceable();

    expect(getLastGlanceableSnapshot()).toEqual({
      ...previousRelease,
      newestResultKind: null,
      newestResultAt: null,
    });
    expect(getLocalScopeKey()).toBe(stored.scopeKey);
  });

  // The previous release stored the snapshot and the scope key as two records.
  // An install that upgrades with that pair on disk must still restore, and the
  // record's own scope key is what a restart uses from then on.
  it('restores a record the previous release wrote as two keys', async () => {
    const stored = snapshotFor([{ status: 'busy' }]);
    store.set(SNAPSHOT_KEY, JSON.stringify(stored));
    store.set(SCOPE_KEY, stored.scopeKey);

    const restarted = await restartPersistModule();
    await restarted.restorePersistedGlanceable();

    expect(restarted.getLastGlanceableSnapshot()).toEqual(stored);
    expect(restarted.getLocalScopeKey()).toBe(stored.scopeKey);
  });

  it('fills the scope from a key the previous release left without a snapshot', async () => {
    store.set(SCOPE_KEY, 'legacy-scope');

    const restarted = await restartPersistModule();
    await restarted.restorePersistedGlanceable();

    expect(restarted.getLastGlanceableSnapshot()).toBeNull();
    expect(restarted.getLocalScopeKey()).toBe('legacy-scope');
  });

  it('restores the Home-widget record on the signed-in scope', async () => {
    const stored = snapshotFor([{ status: 'busy' }]);
    store.set(SNAPSHOT_KEY, JSON.stringify(stored));
    store.set(SCOPE_KEY, stored.scopeKey);
    store.set(HOME_WIDGET_DATA_KEY, JSON.stringify({ snapshot: stored, details: details }));
    store.set(ACTIVE_USER_ID_KEY, 'u1');

    await restorePersistedGlanceable();

    // The record is adopted only when its scope is the signed-in one.
    expect(getLastHomeWidgetData()).toMatchObject({ snapshot: { scopeKey: stored.scopeKey } });
  });

  it('leaves a Home-widget record of another scope unadopted', async () => {
    const stored = snapshotFor([{ status: 'busy' }]);
    store.set(SNAPSHOT_KEY, JSON.stringify(stored));
    store.set(SCOPE_KEY, stored.scopeKey);
    store.set(HOME_WIDGET_DATA_KEY, JSON.stringify({ snapshot: stored, details: details }));
    store.set(ACTIVE_USER_ID_KEY, 'u2');

    await restorePersistedGlanceable();

    // The glanceable record still restores: its revision and scope feed the
    // fences the signed-in context verifies before it writes anything.
    expect(getLastGlanceableSnapshot()).toEqual(stored);
    expect(getLastHomeWidgetData()).toBeNull();
  });

  it('leaves the Home-widget record unadopted when the identity is unreadable', async () => {
    const stored = snapshotFor([{ status: 'busy' }]);
    store.set(SNAPSHOT_KEY, JSON.stringify(stored));
    store.set(SCOPE_KEY, stored.scopeKey);
    store.set(HOME_WIDGET_DATA_KEY, JSON.stringify({ snapshot: stored, details: details }));
    secureStoreMock.getItemAsync.mockImplementation(key =>
      key === ACTIVE_USER_ID_KEY
        ? Promise.reject(new Error('keychain locked'))
        : Promise.resolve(store.get(key) ?? null)
    );

    await restorePersistedGlanceable();

    // An unreadable identity is "unknown", never a match; the mirror itself
    // still read, so it is not reported as unavailable.
    expect(getLastHomeWidgetData()).toBeNull();
    expect(isGlanceableRestoreUnavailable()).toBe(false);
  });
});

describe('mirror writes', () => {
  // A publish is fire-and-forget, so without a chain the slow happy frame can
  // reach SecureStore after the terminal blank that replaced it, and the next
  // JS restart brings back a state the user already left.
  it('leaves the later blank on disk when an earlier publish is still writing', async () => {
    const gate = deferred();
    let writes = 0;
    secureStoreMock.setItemAsync.mockImplementation(async (key: string, value: string) => {
      writes += 1;
      if (writes === 1) {
        // The happy frame's write is slow: it settles only after the terminal
        // blank has been published.
        await gate.promise;
      }
      store.set(key, value);
    });

    const happy = snapshotFor([{ status: 'busy' }]);
    const blank = buildGlanceableSnapshot({
      sessions: [],
      userId: 'u1',
      organizationId: null,
      now: NOW + 1,
      status: 'signed_out',
    });

    persistGlanceableSink.publish(happy);
    persistGlanceableSink.publish(blank);
    gate.resolve();
    await _flushGlanceableMirrorForTests();

    expect(JSON.parse(store.get(SNAPSHOT_KEY) ?? 'null')).toMatchObject({
      status: 'signed_out',
    });

    const restarted = await restartPersistModule();
    await restarted.restorePersistedGlanceable();

    expect(restarted.getLastGlanceableSnapshot()).toEqual(blank);
    expect(restarted.getLocalScopeKey()).toBe(blank.scopeKey);
  });

  // One record per publish carries both facts, so a restart can never pair one
  // publish's snapshot with another publish's scope key.
  it('restores the snapshot and the scope key of the same publish', async () => {
    const first = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'u1',
      organizationId: 'org-1',
      now: NOW,
    });
    const second = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'u1',
      organizationId: 'org-2',
      now: NOW + 1,
    });
    expect(second.scopeKey).not.toBe(first.scopeKey);

    persistGlanceableSink.publish(first);
    persistGlanceableSink.publish(second);
    await _flushGlanceableMirrorForTests();

    const restarted = await restartPersistModule();
    await restarted.restorePersistedGlanceable();

    expect(restarted.getLastGlanceableSnapshot()).toEqual(second);
    expect(restarted.getLocalScopeKey()).toBe(second.scopeKey);
  });
});
