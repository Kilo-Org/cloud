import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  _resetGlanceablePersistForTests,
  _setSecureStoreForTests,
  getLastGlanceableSnapshot,
  getLocalScopeKey,
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

  it('restores a schema-valid stored record', async () => {
    const stored = snapshotFor([{ status: 'busy' }]);
    store.set(SNAPSHOT_KEY, JSON.stringify(stored));
    store.set(SCOPE_KEY, stored.scopeKey);

    await restorePersistedGlanceable();

    expect(getLastGlanceableSnapshot()).toEqual(stored);
    expect(getLocalScopeKey()).toBe(stored.scopeKey);
  });
});
