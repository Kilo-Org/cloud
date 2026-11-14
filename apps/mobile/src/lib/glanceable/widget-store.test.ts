/* eslint-disable max-lines -- one cohesive store suite: the class write, the upgrade, the absence proof and the per-key ordering share one fake store */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { EMPTY_HOME_WIDGET_DETAILS } from '@kilocode/app-shared/home-widget';

import {
  type GatedSecureStore,
  type NativeWidgetStore,
  readGatedValueForUpdate,
  upgradeGatedValue,
  WIDGET_STORE_CLASS_MARKER,
  WIDGET_STORE_UNLOCK_CANARY,
  withWidgetAccessibility,
  writeGatedValue,
} from '@/lib/auth/secure-store-gated';
import {
  _flushHomeWidgetMirrorForTests,
  _resetHomeWidgetDataForTests,
  _setHomeWidgetStoreForTests,
  rememberHomeWidgetSnapshot,
} from '@/lib/glanceable/home-widget-data';
import { chainSave } from '@/lib/hooks/save-chain';
import { setProtectedDataAvailable } from '@/lib/protected-data';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import {
  setBreadcrumbSink,
  setTelemetrySink,
  type TelemetryBreadcrumb,
  type TelemetryEvent,
} from '@/lib/telemetry/error-sink';

import {
  GLANCEABLE_LEGACY_SCOPE_KEY,
  GLANCEABLE_SNAPSHOT_KEY,
  HOME_WIDGET_DATA_KEY,
  migrateWidgetStoreAccessibility,
  SESSION_CARD_SCOPE_KEY,
} from './widget-store';

// The constant iOS resolves at load. Android declares none, so the widget store
// has to tolerate an absent one; both shapes are exercised below.
const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1;
const REFUSED =
  "Calling the 'getValueWithKeyAsync' function has failed: User interaction is not allowed.";

type GetItem = (key: string) => Promise<string | null>;
type SetItem = (key: string, value: string) => Promise<void>;

/** A native module stand-in the case can inspect, wrapped as the app wraps it. */
type InspectableStore = {
  getItem: Mock<GetItem>;
  setItem: Mock<SetItem>;
  /** The native module stand-in, written with the platform's default class. */
  native: NativeWidgetStore;
  gated: GatedSecureStore;
};

const store = new Map<string, string>();
let events: TelemetryEvent[] = [];
let breadcrumbs: TelemetryBreadcrumb[] = [];

async function defaultGetItem(key: string): Promise<string | null> {
  await Promise.resolve();
  return store.get(key) ?? null;
}

async function defaultSetItem(key: string, value: string): Promise<void> {
  await Promise.resolve();
  store.set(key, value);
}

function inspectableStore(write: SetItem = defaultSetItem): InspectableStore {
  const getItem = vi.fn(defaultGetItem);
  const setItem = vi.fn(write);
  const native: NativeWidgetStore = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    getItemAsync: getItem,
    setItemAsync: setItem,
  };
  return { getItem, setItem, native, gated: withWidgetAccessibility(native) };
}

/** Mark the install as upgraded, the state every absence proof needs. */
function markUpgraded(): void {
  store.set(WIDGET_STORE_CLASS_MARKER.key, WIDGET_STORE_CLASS_MARKER.value);
}

function snapshotFor(): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions: [],
    userId: 'u1',
    organizationId: null,
    now: 1_750_000_000_000,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

/** The keys a run wrote, in order. */
function writtenKeys(setItem: Mock<SetItem>): string[] {
  return setItem.mock.calls.map(([key]) => key);
}

beforeEach(() => {
  store.clear();
  events = [];
  breadcrumbs = [];
  setTelemetrySink(event => {
    events.push(event);
  });
  setBreadcrumbSink(breadcrumb => {
    breadcrumbs.push(breadcrumb);
  });
});

afterEach(async () => {
  await _flushHomeWidgetMirrorForTests();
  _resetHomeWidgetDataForTests();
  setProtectedDataAvailable(true);
  setTelemetrySink(null);
  setBreadcrumbSink(null);
  store.clear();
});

describe('the widget store writes with AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY', () => {
  it('writes one item with the class', async () => {
    const { setItem, gated } = inspectableStore();

    await expect(writeGatedValue(() => gated, HOME_WIDGET_DATA_KEY, 'raw')).resolves.toBe(true);

    expect(setItem).toHaveBeenCalledWith(HOME_WIDGET_DATA_KEY, 'raw', {
      keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    expect(store.get(HOME_WIDGET_DATA_KEY)).toBe('raw');
  });

  it('carries the class on the Home mirror a publish writes', async () => {
    const { setItem, gated } = inspectableStore();
    _setHomeWidgetStoreForTests(gated);
    const snapshot = snapshotFor();

    rememberHomeWidgetSnapshot(snapshot);
    await _flushHomeWidgetMirrorForTests();

    expect(setItem).toHaveBeenCalledWith(
      HOME_WIDGET_DATA_KEY,
      JSON.stringify({ snapshot, details: EMPTY_HOME_WIDGET_DETAILS }),
      { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }
    );
  });

  it('reads without a class, so a record of either class still answers', async () => {
    const { getItem, gated } = inspectableStore();
    store.set(SESSION_CARD_SCOPE_KEY, '{"version":1,"cards":{}}');

    await expect(readGatedValueForUpdate(() => gated, SESSION_CARD_SCOPE_KEY)).resolves.toEqual({
      status: 'value',
      value: '{"version":1,"cards":{}}',
    });
    expect(getItem).toHaveBeenCalledWith(SESSION_CARD_SCOPE_KEY);
  });

  it('writes without a class where the platform declares none', async () => {
    const setItem = vi.fn(defaultSetItem);
    const android = withWidgetAccessibility({
      getItemAsync: vi.fn(defaultGetItem),
      setItemAsync: setItem,
    });

    await writeGatedValue(() => android, HOME_WIDGET_DATA_KEY, 'raw');

    expect(setItem).toHaveBeenCalledWith(HOME_WIDGET_DATA_KEY, 'raw', {
      keychainAccessible: undefined,
    });
  });
});

describe('migrateWidgetStoreAccessibility', () => {
  const STORED: Readonly<Record<string, string>> = {
    [HOME_WIDGET_DATA_KEY]: '{"snapshot":{}}',
    [GLANCEABLE_SNAPSHOT_KEY]: '{"scopeKey":"s1"}',
    [GLANCEABLE_LEGACY_SCOPE_KEY]: 'scope-key',
    [SESSION_CARD_SCOPE_KEY]: '{"version":1,"cards":{}}',
    [ACTIVE_USER_ID_KEY]: 'u1',
    [ORGANIZATION_STORAGE_KEY]: 'org-9',
  };

  it('upgrades every stored item once, then marks the class applied', async () => {
    for (const [key, value] of Object.entries(STORED)) {
      store.set(key, value);
    }
    const { setItem, native, gated } = inspectableStore();

    await migrateWidgetStoreAccessibility(
      () => gated,
      () => native
    );

    expect(setItem.mock.calls).toEqual([
      ...Object.entries(STORED).map(([key, value]) => [
        key,
        value,
        { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY },
      ]),
      [
        WIDGET_STORE_CLASS_MARKER.key,
        WIDGET_STORE_CLASS_MARKER.value,
        { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY },
      ],
    ]);
    // Every value is unchanged; only the class moved.
    for (const [key, value] of Object.entries(STORED)) {
      expect(store.get(key)).toBe(value);
    }

    // The marker records the upgrade, so the next start leaves the items alone.
    await migrateWidgetStoreAccessibility(
      () => gated,
      () => native
    );
    expect(writtenKeys(setItem)).toHaveLength(Object.keys(STORED).length + 1);
  });

  it('counts an absent item as done once the canary proves the device unlocked', async () => {
    const { setItem, native, gated } = inspectableStore();

    await migrateWidgetStoreAccessibility(
      () => gated,
      () => native
    );

    // Nothing to rewrite: every empty read is vouched for by a default-class
    // write, and the marker is written last.
    expect(new Set(writtenKeys(setItem))).toEqual(
      new Set([WIDGET_STORE_UNLOCK_CANARY.key, WIDGET_STORE_CLASS_MARKER.key])
    );
    expect(setItem).toHaveBeenLastCalledWith(
      WIDGET_STORE_CLASS_MARKER.key,
      WIDGET_STORE_CLASS_MARKER.value,
      { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }
    );
  });

  it('does not record the upgrade when the canary cannot be written', async () => {
    // A default-class write is refused while the device is locked, so an empty
    // read is no proof of absence then: nothing may be recorded as upgraded.
    const getItem = vi.fn(defaultGetItem);
    const setItem = vi.fn(defaultSetItem);
    const native: NativeWidgetStore = {
      getItemAsync: getItem,
      setItemAsync: vi.fn(async () => {
        await Promise.resolve();
        throw new Error(REFUSED);
      }),
    };
    const gated = withWidgetAccessibility({
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      getItemAsync: getItem,
      setItemAsync: setItem,
    });

    await migrateWidgetStoreAccessibility(
      () => gated,
      () => native
    );

    expect(store.has(WIDGET_STORE_CLASS_MARKER.key)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(breadcrumbs.length).toBeGreaterThan(0);
  });

  it('cannot restore an identity hint a delete removes on its own chain', async () => {
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    const { setItem, native, gated } = inspectableStore();
    // The owner's sign-out delete is already on the key's chain when the upgrade
    // starts; the upgrade joins behind it, so it reads the key as absent instead
    // of writing the id it saw earlier back over the delete.
    const gate = deferred<null>();
    const del = chainSave(ACTIVE_USER_ID_KEY, async () => {
      await gate.promise;
      store.delete(ACTIVE_USER_ID_KEY);
    });
    const migration = migrateWidgetStoreAccessibility(
      () => gated,
      () => native
    );

    gate.resolve(null);
    await Promise.all([del, migration]);

    expect(store.has(ACTIVE_USER_ID_KEY)).toBe(false);
    expect(writtenKeys(setItem)).not.toContain(ACTIVE_USER_ID_KEY);
  });

  it('leaves the marker unwritten when the keychain refuses a read', async () => {
    const { setItem, getItem, native, gated } = inspectableStore();
    getItem.mockRejectedValue(new Error(REFUSED));

    await migrateWidgetStoreAccessibility(
      () => gated,
      () => native
    );

    expect(setItem).not.toHaveBeenCalled();
    expect(store.has(WIDGET_STORE_CLASS_MARKER.key)).toBe(false);
    expect(events).toHaveLength(0);
    expect(breadcrumbs.length).toBeGreaterThan(0);
  });

  it('leaves the marker unwritten when the keychain refuses a write', async () => {
    const { setItem, getItem, native, gated } = inspectableStore(async () => {
      await Promise.resolve();
      throw new Error(REFUSED);
    });
    getItem.mockResolvedValue(null);

    await migrateWidgetStoreAccessibility(
      () => gated,
      () => native
    );

    expect(writtenKeys(setItem)).toEqual([WIDGET_STORE_UNLOCK_CANARY.key]);
    expect(store.has(WIDGET_STORE_CLASS_MARKER.key)).toBe(false);
  });
});

describe('the lock gate on widget items', () => {
  it('attempts a read before the first unlock and leaves a breadcrumb, not an event', async () => {
    setProtectedDataAvailable(false);
    const { getItem, gated } = inspectableStore();
    getItem.mockRejectedValue(new Error(REFUSED));

    await expect(readGatedValueForUpdate(() => gated, HOME_WIDGET_DATA_KEY)).resolves.toEqual({
      status: 'unreadable',
    });

    expect(getItem).toHaveBeenCalledWith(HOME_WIDGET_DATA_KEY);
    expect(events).toHaveLength(0);
    expect(breadcrumbs).toEqual([
      expect.objectContaining({ category: 'secure_store', data: { operation: 'read' } }),
    ]);
  });

  it('does not trust a null while the cached keychain state still says available', async () => {
    // The phone locked while the app was suspended: the cached flag is stale, and
    // the upgrade has not run, so nothing proves this record is unreadable rather
    // than absent.
    const { getItem, gated } = inspectableStore();
    getItem.mockResolvedValue(null);

    await expect(readGatedValueForUpdate(() => gated, GLANCEABLE_SNAPSHOT_KEY)).resolves.toEqual({
      status: 'unreadable',
    });
  });

  it('does not trust a null for an item the upgrade has not reached yet', async () => {
    // An item still on the old class answers null on a locked device even though a
    // class-bearing item would answer, so only the completed upgrade proves it.
    const { gated } = inspectableStore();
    store.set(SESSION_CARD_SCOPE_KEY, '{"version":1,"cards":{}}');

    await expect(readGatedValueForUpdate(() => gated, HOME_WIDGET_DATA_KEY)).resolves.toEqual({
      status: 'unreadable',
    });
  });

  it('reads an absence as absent once the upgrade marker is present', async () => {
    const { gated } = inspectableStore();
    markUpgraded();

    await expect(readGatedValueForUpdate(() => gated, GLANCEABLE_SNAPSHOT_KEY)).resolves.toEqual({
      status: 'value',
      value: null,
    });
  });

  it('reports a real failure on a locked device instead of hiding it', async () => {
    setProtectedDataAvailable(false);
    const { getItem, gated } = inspectableStore();
    getItem.mockRejectedValue(new Error('keychain item could not be decoded'));

    await expect(readGatedValueForUpdate(() => gated, HOME_WIDGET_DATA_KEY)).resolves.toEqual({
      status: 'unreadable',
    });

    expect(breadcrumbs).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.fingerprint).toEqual(['secure-store-failure', 'read']);
    expect(events[0]?.tags).toEqual({
      'error.subsystem': 'secure_store',
      'error.operation': 'read',
    });
  });

  it('attempts a write on a locked device instead of skipping it', async () => {
    setProtectedDataAvailable(false);
    const { setItem, gated } = inspectableStore();

    await expect(
      writeGatedValue(() => gated, GLANCEABLE_SNAPSHOT_KEY, '{"scopeKey":"s1"}')
    ).resolves.toBe(true);

    expect(setItem).toHaveBeenCalledWith(GLANCEABLE_SNAPSHOT_KEY, '{"scopeKey":"s1"}', {
      keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  });
});

describe('the class upgrade', () => {
  it('cannot replace a value a publish writes while it holds the item open', async () => {
    const { getItem, gated } = inspectableStore();
    const read = deferred<string | null>();
    getItem.mockReturnValueOnce(read.promise);
    store.set(GLANCEABLE_SNAPSHOT_KEY, '{"scopeKey":"old"}');

    const upgrade = upgradeGatedValue(() => gated, GLANCEABLE_SNAPSHOT_KEY);
    // The publish is issued while the upgrade still holds the read open. It
    // waits on the item's queue, so the upgrade's write of the value it read
    // can never land after the newer one.
    const publish = writeGatedValue(() => gated, GLANCEABLE_SNAPSHOT_KEY, '{"scopeKey":"new"}');
    read.resolve('{"scopeKey":"old"}');

    await expect(upgrade).resolves.toBe(true);
    await expect(publish).resolves.toBe(true);
    expect(store.get(GLANCEABLE_SNAPSHOT_KEY)).toBe('{"scopeKey":"new"}');
  });
});
