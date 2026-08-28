/* eslint-disable max-lines -- one cohesive notification suite sharing the glanceable sink and native module mock harness. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildOpaqueScopeKey,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { writePrivacySnapshotAndEnd, writeSignedOutSnapshotAndEnd } from '@/lib/glanceable/cleanup';
import {
  _resetGlanceablePersistForTests,
  _setLastGlanceableSnapshotForTests,
  _setSecureStoreForTests,
  getLastGlanceableSnapshot,
  getLocalScopeKey,
  persistGlanceableSink,
} from '@/lib/glanceable/persist';
import {
  type GlanceableSinkContext,
  registerGlanceableSink,
  unregisterGlanceableSink,
} from '@/lib/glanceable/sink-registry';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import {
  _setGlanceableSinksLoaderForTests,
  applyGlanceablePushData,
  setupNotificationBackgroundHandler,
} from './notifications';

const mocks = vi.hoisted(() => {
  const platform = { OS: 'android' as string };
  return {
    platform,
    setNotificationChannelAsync: vi.fn(),
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
    captureException: vi.fn(),
    addNotificationResponseReceivedListener: vi.fn(),
    clearLastNotificationResponse: vi.fn(),
    notificationPathForData: vi.fn(),
    setPendingDeepLink: vi.fn(),
    safeParse: vi.fn(),
    getItemAsync: vi.fn(),
    defineTask: vi.fn(),
    registerTaskAsync: vi.fn(),
    captureEvent: vi.fn(),
  };
});

vi.mock('react-native', () => ({
  Platform: mocks.platform,
}));

vi.mock('expo-notifications', () => ({
  setNotificationChannelAsync: mocks.setNotificationChannelAsync,
  getPermissionsAsync: mocks.getPermissionsAsync,
  requestPermissionsAsync: mocks.requestPermissionsAsync,
  getExpoPushTokenAsync: mocks.getExpoPushTokenAsync,
  setNotificationHandler: vi.fn(),
  addNotificationResponseReceivedListener: mocks.addNotificationResponseReceivedListener,
  getLastNotificationResponse: vi.fn(),
  clearLastNotificationResponse: mocks.clearLastNotificationResponse,
  registerTaskAsync: mocks.registerTaskAsync,
  BackgroundNotificationTaskResult: { NewData: 0, NoData: 1, Failed: 2 },
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
}));

vi.mock('expo-task-manager', () => ({
  defineTask: mocks.defineTask,
}));

vi.mock('@sentry/react-native', () => ({
  captureException: mocks.captureException,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { eas: { projectId: 'proj-1' } } } },
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: mocks.getItemAsync,
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock('@kilocode/notifications', () => ({
  ANDROID_NOTIFICATION_CHANNELS: [
    { id: 'agent', name: 'Agent sessions', importance: 'high' },
    { id: 'chat', name: 'Chat messages', importance: 'high' },
    { id: 'kiloclaw', name: 'KiloClaw activity', importance: 'default' },
    { id: 'balance', name: 'Balance alerts', importance: 'default' },
    { id: 'security', name: 'Security findings', importance: 'high' },
    { id: 'active-agents', name: 'Active agents', importance: 'default' },
  ],
  pushDataSchema: { safeParse: mocks.safeParse },
}));

vi.mock('@/lib/deep-link-launch', () => ({
  setPendingDeepLink: mocks.setPendingDeepLink,
}));

vi.mock('@/lib/notification-path', () => ({
  notificationPathForData: mocks.notificationPathForData,
}));

vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: mocks.captureEvent,
}));

// Each test re-imports the module so the module-level single-flight promise
// (`androidChannelsPromise`) starts fresh.
async function loadNotifications() {
  vi.resetModules();
  const mod = await import('./notifications');
  return mod;
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

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.OS = 'android';
  mocks.setNotificationChannelAsync.mockResolvedValue(undefined);
  mocks.getPermissionsAsync.mockResolvedValue({ status: 'denied' });
  mocks.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });
  mocks.getExpoPushTokenAsync.mockResolvedValue({ data: 'expo-token' });
  mocks.safeParse.mockReturnValue({ success: false });
  mocks.addNotificationResponseReceivedListener.mockReset();
});

describe('ensureAndroidNotificationChannels', () => {
  it('is a no-op on iOS', async () => {
    mocks.platform.OS = 'ios';
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await ensureAndroidNotificationChannels();

    expect(mocks.setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it('silences the aggregate channel on first creation without changing other channels', async () => {
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await ensureAndroidNotificationChannels();

    expect(mocks.setNotificationChannelAsync.mock.calls).toEqual([
      ['agent', { name: 'Agent sessions', importance: 4 }],
      ['chat', { name: 'Chat messages', importance: 4 }],
      ['kiloclaw', { name: 'KiloClaw activity', importance: 3 }],
      ['balance', { name: 'Balance alerts', importance: 3 }],
      ['security', { name: 'Security findings', importance: 4 }],
      [
        'active-agents',
        { name: 'Active agents', importance: 3, sound: null, enableVibrate: false },
      ],
    ]);
  });

  it('also silences first creation through channel renaming without changing other options', async () => {
    const { renameAndroidNotificationChannels } = await loadNotifications();

    await renameAndroidNotificationChannels();

    expect(mocks.setNotificationChannelAsync.mock.calls).toEqual([
      ['agent', { name: expect.any(String), importance: 4 }],
      ['chat', { name: expect.any(String), importance: 4 }],
      ['kiloclaw', { name: expect.any(String), importance: 3 }],
      ['balance', { name: expect.any(String), importance: 3 }],
      ['security', { name: expect.any(String), importance: 4 }],
      [
        'active-agents',
        { name: expect.any(String), importance: 3, sound: null, enableVibrate: false },
      ],
    ]);
  });

  it('single-flights concurrent callers to one creation pass', async () => {
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    const first = ensureAndroidNotificationChannels();
    const second = ensureAndroidNotificationChannels();

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledTimes(6);
  });

  it('swallows a per-channel failure and still creates the remaining channels', async () => {
    mocks.setNotificationChannelAsync.mockRejectedValueOnce(new Error('channel failed'));
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await expect(ensureAndroidNotificationChannels()).resolves.toBeUndefined();

    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledTimes(6);
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        'error.subsystem': 'notifications',
        'error.operation': 'create_android_channel',
        'notification.channel': 'agent',
      },
    });
  });
});

describe('channel creation ordering', () => {
  it('registerForPushNotifications awaits channel creation before reading permission', async () => {
    const gate = deferred();
    mocks.setNotificationChannelAsync.mockImplementation(async () => {
      await gate.promise;
    });
    const { registerForPushNotifications } = await loadNotifications();

    const result = registerForPushNotifications();
    await flushMicrotasks();

    expect(mocks.getPermissionsAsync).not.toHaveBeenCalled();

    gate.resolve();
    await result;

    expect(mocks.getPermissionsAsync).toHaveBeenCalled();
  });

  it('getDevicePushToken awaits channel creation before reading permission', async () => {
    const gate = deferred();
    mocks.setNotificationChannelAsync.mockImplementation(async () => {
      await gate.promise;
    });
    const { getDevicePushToken } = await loadNotifications();

    const result = getDevicePushToken();
    await flushMicrotasks();

    expect(mocks.getPermissionsAsync).not.toHaveBeenCalled();

    gate.resolve();
    await result;

    expect(mocks.getPermissionsAsync).toHaveBeenCalled();
  });
});

describe('setupNotificationResponseHandler', () => {
  type ResponseListener = (response: {
    notification: { request: { content: { data: unknown } } };
  }) => void;

  it('stashes the destination and does not navigate', async () => {
    mocks.safeParse.mockReturnValue({ success: true, data: { type: 'chat.message' } });
    mocks.notificationPathForData.mockReturnValue('/(app)/(tabs)/(1_kiloclaw)/chat/s1/c1?via=push');
    mocks.addNotificationResponseReceivedListener.mockImplementation(
      (listener: ResponseListener) => {
        listener({
          notification: { request: { content: { data: { type: 'chat.message' } } } },
        });
        return { remove: vi.fn() };
      }
    );

    const { setupNotificationResponseHandler } = await loadNotifications();
    setupNotificationResponseHandler();

    expect(mocks.setPendingDeepLink).toHaveBeenCalledWith(
      '/(app)/(tabs)/(1_kiloclaw)/chat/s1/c1?via=push',
      'notification'
    );
    expect(mocks.clearLastNotificationResponse).toHaveBeenCalled();
  });

  it('ignores a response with unparseable data', async () => {
    mocks.safeParse.mockReturnValue({ success: false });
    mocks.addNotificationResponseReceivedListener.mockImplementation(
      (listener: ResponseListener) => {
        listener({
          notification: { request: { content: { data: { type: 'chat.message' } } } },
        });
        return { remove: vi.fn() };
      }
    );

    const { setupNotificationResponseHandler } = await loadNotifications();
    setupNotificationResponseHandler();

    expect(mocks.setPendingDeepLink).not.toHaveBeenCalled();
    expect(mocks.clearLastNotificationResponse).not.toHaveBeenCalled();
  });
});

const SCOPE_KEY = buildOpaqueScopeKey({ userId: 'u1', organizationId: 'org-9' });

function glanceableSnapshot(
  overrides: Partial<GlanceableAgentsSnapshot> = {}
): GlanceableAgentsSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T08:00:00.000Z',
    scopeKey: SCOPE_KEY,
    organizationBound: true,
    status: 'happy',
    running: 1,
    needsInput: 0,
    reconnecting: 0,
    eligibleStartedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

type GlanceablePushData = Parameters<typeof applyGlanceablePushData>[0];

function activeGlanceablePush(
  overrides: Partial<GlanceableAgentsSnapshot> = {}
): GlanceablePushData {
  return {
    type: 'active_agents_glanceable',
    ...glanceableSnapshot(overrides),
  };
}

function makeFakeSink() {
  const surface: {
    widget: GlanceableAgentsSnapshot | null;
    activity: GlanceableAgentsSnapshot | null;
    context: GlanceableSinkContext | null;
  } = { widget: null, activity: null, context: null };
  return {
    surface,
    publish: vi.fn((snapshot: GlanceableAgentsSnapshot) => {
      surface.widget = snapshot;
    }),
    endImmediate: vi.fn(() => {
      surface.activity = null;
      surface.context = null;
    }),
    startOrUpdate: vi.fn((snapshot: GlanceableAgentsSnapshot, context: GlanceableSinkContext) => {
      surface.activity = snapshot;
      surface.context = context;
    }),
  };
}

// Key-aware expo-secure-store surface: `applyGlanceablePushData` reads both the
// selected-organization id and the active-user id hint through the module-level
// `SecureStore.getItemAsync`, so the mock must answer each key separately.
function mockSecureStoreKeys() {
  mocks.getItemAsync.mockImplementation((key: string) => {
    if (key === ACTIVE_USER_ID_KEY) {
      return 'u1';
    }
    if (key === ORGANIZATION_STORAGE_KEY) {
      return 'org-9';
    }
    return null;
  });
}

function delayIdentityRead(delayedKey: string) {
  const started = deferred();
  const gate = deferred();
  let pending = true;
  mocks.getItemAsync.mockImplementation(async (key: string) => {
    const value = key === ACTIVE_USER_ID_KEY ? 'u1' : 'org-9';
    if (key === delayedKey && pending) {
      pending = false;
      started.resolve();
      await gate.promise;
    }
    return value;
  });
  return { started: started.promise, resolve: gate.resolve };
}

// Map-backed SecureStore surface for the persist module's restore path. The
// persist module lazy-`require`s `expo-secure-store` (a native module), which
// cannot load in the pure-vitest suite, so the restore tests inject this store
// through the test-only setter — the same pattern persist.test.ts uses.
const secureStore = new Map<string, string>();
const secureStoreMock = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStore.set(key, value);
    await Promise.resolve();
  }),
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return secureStore.get(key) ?? null;
  }),
};

describe('applyGlanceablePushData', () => {
  beforeEach(() => {
    _resetGlanceablePersistForTests();
    mockSecureStoreKeys();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('discards a remote snapshot that is not newer than the last applied snapshot', async () => {
    _setLastGlanceableSnapshotForTests(
      glanceableSnapshot({
        scopeKey: SCOPE_KEY,
        revision: 3,
        updatedAt: '2026-01-02T00:00:00.000Z',
      })
    );
    const sink = makeFakeSink();
    registerGlanceableSink(sink);

    const result = await applyGlanceablePushData(
      activeGlanceablePush({ scopeKey: SCOPE_KEY, updatedAt: '2026-01-01T00:00:00.000Z' })
    );

    expect(result).toBe(false);
    expect(sink.publish).not.toHaveBeenCalled();
    expect(sink.startOrUpdate).not.toHaveBeenCalled();

    unregisterGlanceableSink(sink);
  });

  it('applies a newer remote snapshot and re-registers under the selected organization', async () => {
    _setLastGlanceableSnapshotForTests(
      glanceableSnapshot({
        scopeKey: SCOPE_KEY,
        revision: 3,
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const sink = makeFakeSink();
    registerGlanceableSink(sink);

    const result = await applyGlanceablePushData(
      activeGlanceablePush({
        scopeKey: SCOPE_KEY,
        updatedAt: '2026-01-02T00:00:00.000Z',
        organizationBound: true,
      })
    );

    expect(result).toBe(true);
    // The rebased revision continues the local monotonic sequence.
    expect(sink.publish).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }));
    expect(sink.startOrUpdate).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }), {
      userId: 'u1',
      organizationId: 'org-9',
    });

    unregisterGlanceableSink(sink);
  });

  it('ends the sinks after the terminal window for a non-eligible remote snapshot', async () => {
    vi.useFakeTimers();
    _setLastGlanceableSnapshotForTests(
      glanceableSnapshot({
        scopeKey: SCOPE_KEY,
        revision: 3,
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const sink = makeFakeSink();
    registerGlanceableSink(sink);

    const result = await applyGlanceablePushData(
      activeGlanceablePush({
        scopeKey: SCOPE_KEY,
        updatedAt: '2026-01-02T00:00:00.000Z',
        status: 'empty',
        running: 0,
        needsInput: 0,
        reconnecting: 0,
        eligibleStartedAt: null,
      })
    );

    expect(result).toBe(true);
    // The empty snapshot is published (widgets keep the latest counts), but
    // the Live Activity / ongoing is not ended until the terminal window.
    expect(sink.publish).toHaveBeenCalledTimes(1);
    expect(sink.startOrUpdate).not.toHaveBeenCalled();
    expect(sink.endImmediate).not.toHaveBeenCalled();

    // The persist sink writes the empty snapshot before the terminal fires, so
    // the fire-time eligibility guard sees non-eligible work and ends it.
    _setLastGlanceableSnapshotForTests(
      glanceableSnapshot({
        scopeKey: SCOPE_KEY,
        revision: 4,
        updatedAt: '2026-01-02T00:00:00.000Z',
        status: 'empty',
        running: 0,
        needsInput: 0,
        reconnecting: 0,
        eligibleStartedAt: null,
      })
    );

    vi.advanceTimersByTime(8000);
    expect(sink.endImmediate).toHaveBeenCalledTimes(1);

    unregisterGlanceableSink(sink);
  });

  it('cancels the pending terminal when a newer eligible snapshot arrives', async () => {
    vi.useFakeTimers();
    _setLastGlanceableSnapshotForTests(
      glanceableSnapshot({
        scopeKey: SCOPE_KEY,
        revision: 3,
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const sink = makeFakeSink();
    registerGlanceableSink(sink);

    await applyGlanceablePushData(
      activeGlanceablePush({
        scopeKey: SCOPE_KEY,
        updatedAt: '2026-01-02T00:00:00.000Z',
        status: 'empty',
        running: 0,
        needsInput: 0,
        reconnecting: 0,
        eligibleStartedAt: null,
      })
    );
    await applyGlanceablePushData(
      activeGlanceablePush({
        scopeKey: SCOPE_KEY,
        updatedAt: '2026-01-03T00:00:00.000Z',
        organizationBound: true,
      })
    );

    vi.advanceTimersByTime(8000);
    // The later eligible snapshot cancelled the 8s terminal: work restarted,
    // so the activity must not end.
    expect(sink.endImmediate).not.toHaveBeenCalled();

    unregisterGlanceableSink(sink);
  });
});

describe('glanceable publication storage fences', () => {
  const sink = makeFakeSink();

  beforeEach(() => {
    vi.useFakeTimers();
    _resetGlanceablePersistForTests();
    _setSecureStoreForTests(secureStoreMock);
    _setLastGlanceableSnapshotForTests(glanceableSnapshot({ revision: 3 }));
    secureStore.clear();
    mockSecureStoreKeys();
    sink.surface.widget = null;
    sink.surface.activity = null;
    sink.surface.context = null;
    registerGlanceableSink(persistGlanceableSink);
    registerGlanceableSink(sink);
  });

  afterEach(() => {
    unregisterGlanceableSink(sink);
    unregisterGlanceableSink(persistGlanceableSink);
    _resetGlanceablePersistForTests();
    vi.useRealTimers();
  });

  it('publishes authorized personal work without an organization hint', async () => {
    const scopeKey = buildOpaqueScopeKey({ userId: 'u1', organizationId: null });
    _setLastGlanceableSnapshotForTests(
      glanceableSnapshot({ scopeKey, organizationBound: false, revision: 3 })
    );
    mocks.getItemAsync.mockImplementation((key: string) =>
      key === ACTIVE_USER_ID_KEY ? 'u1' : null
    );

    const applied = await applyGlanceablePushData(
      activeGlanceablePush({
        scopeKey,
        organizationBound: false,
        updatedAt: '2026-01-02T00:00:00.000Z',
        running: 9,
      })
    );

    expect(applied).toBe(true);
    expect(sink.surface.widget).toMatchObject({ scopeKey, revision: 4, running: 9 });
    expect(sink.surface.activity).toEqual(sink.surface.widget);
    expect(sink.surface.context).toEqual({ userId: 'u1', organizationId: null });
  });

  it.each([
    [null, 'org-9'],
    ['u2', 'org-9'],
    ['u1', null],
    ['u1', 'org-10'],
  ])(
    'rejects identity hints %s / %s outside the persisted scope',
    async (userId, organizationId) => {
      mocks.getItemAsync.mockImplementation((key: string) =>
        key === ACTIVE_USER_ID_KEY ? userId : organizationId
      );
      const current = getLastGlanceableSnapshot();

      const applied = await applyGlanceablePushData(
        activeGlanceablePush({ updatedAt: '2026-01-02T00:00:00.000Z', running: 9 })
      );

      expect(applied).toBe(false);
      expect(getLastGlanceableSnapshot()).toBe(current);
      expect(sink.surface.widget).toBeNull();
      expect(sink.surface.activity).toBeNull();
    }
  );

  it.each([ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY])('rejects a failed %s read', async key => {
    mocks.getItemAsync.mockImplementation((requestedKey: string) => {
      if (requestedKey === key) {
        throw new Error('storage unavailable');
      }
      return requestedKey === ACTIVE_USER_ID_KEY ? 'u1' : 'org-9';
    });

    const applied = await applyGlanceablePushData(activeGlanceablePush());

    expect(applied).toBe(false);
    expect(sink.surface.widget).toBeNull();
    expect(sink.surface.activity).toBeNull();
  });

  describe.each([ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY])(
    'while %s is pending',
    delayedKey => {
      it.each([
        ['logout', writeSignedOutSnapshotAndEnd],
        ['account switch', bumpAuthEpoch],
        ['organization switch', writePrivacySnapshotAndEnd],
      ] as const)('does not restore counts after %s', async (_label, invalidate) => {
        const read = delayIdentityRead(delayedKey);
        const applying = applyGlanceablePushData(
          activeGlanceablePush({ updatedAt: '2026-01-02T00:00:00.000Z', running: 9 })
        );
        await read.started;

        invalidate();
        const current = getLastGlanceableSnapshot();
        const widget = sink.surface.widget;
        const scopeKey = getLocalScopeKey();
        read.resolve();

        expect(await applying).toBe(false);
        expect(getLastGlanceableSnapshot()).toBe(current);
        expect(getLocalScopeKey()).toBe(scopeKey);
        expect(sink.surface.widget).toBe(widget);
        expect(sink.surface.activity).toBeNull();
      });

      it('rejects captured work even when the blanked scope becomes current again', async () => {
        const read = delayIdentityRead(delayedKey);
        const applying = applyGlanceablePushData(
          activeGlanceablePush({ updatedAt: '2026-01-02T00:00:00.000Z', running: 9 })
        );
        await read.started;
        writePrivacySnapshotAndEnd();
        const authorized = glanceableSnapshot({ running: 2, revision: 5 });
        persistGlanceableSink.publish(authorized);
        sink.publish(authorized);
        sink.startOrUpdate(authorized, { userId: 'u1', organizationId: 'org-9' });
        read.resolve();

        expect(await applying).toBe(false);
        expect(getLastGlanceableSnapshot()).toEqual(authorized);
        expect(sink.surface.widget).toEqual(authorized);
        expect(sink.surface.activity).toEqual(authorized);
      });

      it('keeps a replacement scope when storage still returns the old identity', async () => {
        const read = delayIdentityRead(delayedKey);
        const applying = applyGlanceablePushData(
          activeGlanceablePush({ updatedAt: '2026-01-02T00:00:00.000Z', running: 9 })
        );
        await read.started;
        const replacement = glanceableSnapshot({
          scopeKey: buildOpaqueScopeKey({ userId: 'u1', organizationId: 'org-10' }),
          running: 7,
        });
        persistGlanceableSink.publish(replacement);
        sink.publish(replacement);
        read.resolve();

        expect(await applying).toBe(false);
        expect(getLastGlanceableSnapshot()).toEqual(replacement);
        expect(sink.surface.widget).toEqual(replacement);
        expect(sink.surface.activity).toBeNull();
      });

      it.each([
        [0, '2026-01-02T00:00:00.000Z'],
        [9, '2026-01-02T00:00:00.000Z'],
        [0, '2026-01-03T00:00:00.000Z'],
        [9, '2026-01-03T00:00:00.000Z'],
      ] as const)(
        'discards captured counts (%s) after publication at %s',
        async (running, updatedAt) => {
          const read = delayIdentityRead(delayedKey);
          const applying = applyGlanceablePushData(
            activeGlanceablePush({
              updatedAt: '2026-01-02T00:00:00.000Z',
              running,
              status: running === 0 ? 'empty' : 'happy',
              eligibleStartedAt: running === 0 ? null : '2026-01-01T00:00:00.000Z',
            })
          );
          await read.started;
          expect(
            await applyGlanceablePushData(activeGlanceablePush({ updatedAt, running: 7 }))
          ).toBe(true);
          const latest = getLastGlanceableSnapshot();
          read.resolve();

          expect(await applying).toBe(false);
          vi.advanceTimersByTime(8000);
          expect(getLastGlanceableSnapshot()).toBe(latest);
          expect(sink.surface.widget).toEqual(latest);
          expect(sink.surface.activity).toEqual(latest);
          expect(sink.surface.activity?.running).toBe(7);
        }
      );

      it('rebases a current remote snapshot above an intervening publication', async () => {
        const read = delayIdentityRead(delayedKey);
        const applying = applyGlanceablePushData(
          activeGlanceablePush({ updatedAt: '2026-01-03T00:00:00.000Z', running: 9 })
        );
        await read.started;
        expect(
          await applyGlanceablePushData(
            activeGlanceablePush({ updatedAt: '2026-01-02T00:00:00.000Z', running: 2 })
          )
        ).toBe(true);
        read.resolve();

        expect(await applying).toBe(true);
        expect(sink.surface.widget).toMatchObject({
          running: 9,
          revision: 5,
          accountEpoch: currentAuthEpoch(),
        });
        expect(sink.surface.activity).toEqual(sink.surface.widget);
        expect(getLastGlanceableSnapshot()).toEqual(sink.surface.widget);
        expect(sink.surface.context).toEqual({ userId: 'u1', organizationId: 'org-9' });
      });
    }
  );
});

describe('setupNotificationBackgroundHandler', () => {
  type HeadlessExecutor = (body: {
    data: unknown;
    error: unknown;
    executionInfo: unknown;
  }) => Promise<unknown>;

  function executorFor(mock: typeof mocks.defineTask): HeadlessExecutor {
    const firstCall = mock.mock.calls[0];
    if (!firstCall) {
      throw new Error('defineTask was not called before executorFor');
    }
    return firstCall[1] as HeadlessExecutor;
  }

  beforeEach(() => {
    _resetGlanceablePersistForTests();
    _setSecureStoreForTests(secureStoreMock);
    secureStore.clear();
    mockSecureStoreKeys();
    mocks.defineTask.mockReset();
    mocks.registerTaskAsync.mockResolvedValue(null);
  });

  afterEach(() => {
    _resetGlanceablePersistForTests();
    secureStore.clear();
  });

  it('restores the persisted fence then applies a glanceable push via applyGlanceablePushData', async () => {
    // Leave in-memory state empty and persist the fence in SecureStore instead,
    // exactly as a killed process finds it. The executor must call
    // `restorePersistedGlanceable` before applying; without it the scope-key
    // fence discards the push and the sink never publishes.
    const persisted = glanceableSnapshot({
      scopeKey: SCOPE_KEY,
      revision: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    secureStore.set('glanceable-snapshot', JSON.stringify(persisted));
    secureStore.set('glanceable-scope-key', SCOPE_KEY);
    mocks.safeParse.mockImplementation((data: unknown) => ({ success: true, data }));
    _setGlanceableSinksLoaderForTests(() => undefined);

    const sink = makeFakeSink();
    registerGlanceableSink(sink);

    setupNotificationBackgroundHandler();

    expect(mocks.defineTask).toHaveBeenCalledTimes(1);
    expect(mocks.defineTask).toHaveBeenCalledWith(
      'active-agents-glanceable-background-task',
      expect.any(Function)
    );
    expect(mocks.registerTaskAsync).toHaveBeenCalledWith(
      'active-agents-glanceable-background-task'
    );

    const executor = executorFor(mocks.defineTask);
    const result = await executor({
      data: {
        notification: null,
        data: {
          dataString: JSON.stringify(
            activeGlanceablePush({
              scopeKey: SCOPE_KEY,
              updatedAt: '2026-01-02T00:00:00.000Z',
              organizationBound: true,
            })
          ),
        },
      },
      error: null,
      executionInfo: { eventId: 'e1', taskName: 'active-agents-glanceable-background-task' },
    });

    // A successful apply delivered new sink data, so the executor reports
    // NewData (0), not NoData (1), which throttles iOS content-available wakes.
    expect(result).toBe(0);
    // The rebased revision proves the restored fence and the single apply code
    // path ran, not a duplicated one.
    expect(sink.publish).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
    expect(sink.startOrUpdate).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }), {
      userId: 'u1',
      organizationId: 'org-9',
    });

    unregisterGlanceableSink(sink);
  });

  it('ignores a headless payload that is not a glanceable push', async () => {
    mocks.safeParse.mockImplementation((data: unknown) => ({ success: true, data }));
    _setGlanceableSinksLoaderForTests(() => undefined);

    const sink = makeFakeSink();
    registerGlanceableSink(sink);

    setupNotificationBackgroundHandler();

    const executor = executorFor(mocks.defineTask);
    await executor({
      data: {
        notification: null,
        data: { dataString: JSON.stringify({ type: 'chat.message' }) },
      },
      error: null,
      executionInfo: { eventId: 'e2', taskName: 'active-agents-glanceable-background-task' },
    });

    expect(sink.publish).not.toHaveBeenCalled();

    unregisterGlanceableSink(sink);
  });
});

describe('notification permission and token events', () => {
  it('emits granted when a live permission request is granted', async () => {
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'denied' });
    mocks.requestPermissionsAsync.mockResolvedValue({ status: 'granted' });
    const { registerForPushNotifications } = await loadNotifications();

    await registerForPushNotifications();

    expect(mocks.captureEvent).toHaveBeenCalledWith('notification_permission_responded', {
      outcome: 'granted',
    });
  });

  it('emits denied when a live permission request is denied', async () => {
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'denied' });
    mocks.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });
    const { registerForPushNotifications } = await loadNotifications();

    await registerForPushNotifications();

    expect(mocks.captureEvent).toHaveBeenCalledWith('notification_permission_responded', {
      outcome: 'denied',
    });
  });

  it('does not emit a permission outcome when already granted', async () => {
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'granted' });
    const { registerForPushNotifications } = await loadNotifications();

    await registerForPushNotifications();

    expect(mocks.captureEvent).not.toHaveBeenCalled();
  });

  it('emits a registered token action', async () => {
    const { emitNotificationTokenUpdated } = await loadNotifications();

    emitNotificationTokenUpdated('registered');

    expect(mocks.captureEvent).toHaveBeenCalledWith('notification_token_updated', {
      action: 'registered',
    });
  });

  it('emits an unregistered token action', async () => {
    const { emitNotificationTokenUpdated } = await loadNotifications();

    emitNotificationTokenUpdated('unregistered');

    expect(mocks.captureEvent).toHaveBeenCalledWith('notification_token_updated', {
      action: 'unregistered',
    });
  });
});
