import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { EMPTY_HOME_WIDGET_DETAILS } from '@kilocode/app-shared/home-widget';

import {
  type GatedSecureStore,
  readGatedValue,
  withWidgetAccessibility,
  writeGatedValue,
} from '@/lib/auth/secure-store-gated';
import {
  _flushHomeWidgetMirrorForTests,
  _resetHomeWidgetDataForTests,
  _setHomeWidgetStoreForTests,
  rememberHomeWidgetSnapshot,
} from '@/lib/glanceable/home-widget-data';
import { setProtectedDataAvailable } from '@/lib/protected-data';
import {
  setBreadcrumbSink,
  setTelemetrySink,
  type TelemetryBreadcrumb,
  type TelemetryEvent,
} from '@/lib/telemetry/error-sink';

import {
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

function inspectableStore(): InspectableStore {
  const getItem = vi.fn(defaultGetItem);
  const setItem = vi.fn(defaultSetItem);
  return {
    getItem,
    setItem,
    gated: withWidgetAccessibility({
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      getItemAsync: getItem,
      setItemAsync: setItem,
    }),
  };
}

function snapshotFor(): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions: [],
    userId: 'u1',
    organizationId: null,
    now: 1_750_000_000_000,
  });
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

    await expect(readGatedValue(() => gated, SESSION_CARD_SCOPE_KEY)).resolves.toBe(
      '{"version":1,"cards":{}}'
    );
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
  it('rewrites an existing item with the class exactly once', async () => {
    store.set(GLANCEABLE_SNAPSHOT_KEY, '{"scopeKey":"s1"}');
    const { setItem, gated } = inspectableStore();

    await migrateWidgetStoreAccessibility(() => gated);

    expect(setItem.mock.calls).toEqual([
      [
        GLANCEABLE_SNAPSHOT_KEY,
        '{"scopeKey":"s1"}',
        { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY },
      ],
      [
        'widget-store-accessibility',
        'after-first-unlock',
        { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY },
      ],
    ]);
    expect(store.get(GLANCEABLE_SNAPSHOT_KEY)).toBe('{"scopeKey":"s1"}');

    // The marker records the upgrade, so the next start leaves the item alone.
    await migrateWidgetStoreAccessibility(() => gated);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('skips a key the install never stored', async () => {
    store.set(HOME_WIDGET_DATA_KEY, '{"snapshot":{}}');
    const { setItem, gated } = inspectableStore();

    await migrateWidgetStoreAccessibility(() => gated);

    expect(setItem.mock.calls.map(([key]) => key)).toEqual([
      HOME_WIDGET_DATA_KEY,
      'widget-store-accessibility',
    ]);
  });

  it('leaves the marker unwritten when the keychain refuses a read', async () => {
    const { setItem, getItem, gated } = inspectableStore();
    getItem.mockRejectedValue(new Error(REFUSED));

    await migrateWidgetStoreAccessibility(() => gated);

    expect(setItem).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(breadcrumbs).toHaveLength(1);
  });
});

describe('the lock gate on widget items', () => {
  it('attempts a read before the first unlock and leaves a breadcrumb, not an event', async () => {
    setProtectedDataAvailable(false);
    const { getItem, gated } = inspectableStore();
    getItem.mockRejectedValue(new Error(REFUSED));

    await expect(readGatedValue(() => gated, HOME_WIDGET_DATA_KEY)).resolves.toBeNull();

    expect(getItem).toHaveBeenCalledWith(HOME_WIDGET_DATA_KEY);
    expect(events).toHaveLength(0);
    expect(breadcrumbs).toEqual([
      expect.objectContaining({ category: 'secure_store', data: { operation: 'read' } }),
    ]);
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
