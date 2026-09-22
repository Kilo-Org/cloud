import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  _resetGlanceablePersistForTests,
  _setGlanceableRestoreUnavailableForTests,
  _setLastGlanceableSnapshotForTests,
  _setSecureStoreForTests,
  getLastGlanceableSnapshot,
  getLocalScopeKey,
  isGlanceableRestoreUnavailable,
  persistGlanceableSink,
  restorePersistedGlanceable,
} from './persist';

const NOW = 1_750_000_000_000;
const SNAPSHOT_KEY = 'glanceable-snapshot';
const SCOPE_KEY = 'glanceable-scope-key';

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

beforeEach(() => {
  _resetGlanceablePersistForTests();
  _setSecureStoreForTests(secureStoreMock);
  store.clear();
  vi.clearAllMocks();
});

afterEach(() => {
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
});
