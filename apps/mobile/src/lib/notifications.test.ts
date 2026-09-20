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

import type * as Notifications from '@kilocode/notifications';

type Response = { notification: { request: { content: { data: unknown } } } };
type ResponseListener = (response: Response) => void;

const mocks = vi.hoisted(() => ({
  platform: { OS: 'android' as string },
  appState: { currentState: 'active' as string },
  setBadgeCountAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
  getNotificationChannelAsync: vi.fn(),
  deleteNotificationChannelAsync: vi.fn(),
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  captureException: vi.fn(),
  lastResponse: null as Response | null,
  listeners: new Set<ResponseListener>(),
  clearLastNotificationResponse: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  nativeInstances: vi.fn(),
  startTokenListeners: new Set<(event: { activityPushToStartToken: string }) => void>(),
  registerActivityToken: vi.fn(),
  unregisterActivityToken: vi.fn(),
  refreshActiveSessionsFromPush: vi.fn(),
  defineTask: vi.fn(),
  registerTaskAsync: vi.fn(),
  captureEvent: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  dismissNotificationAsync: vi.fn(),
  runNeedsInputInteraction: vi.fn(),
  requireOptionalNativeModule: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  AppState: {
    get currentState() {
      return mocks.appState.currentState;
    },
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

// The Focus filter reads through `requireOptionalNativeModule`; the per-test
// return value stands in for what the active iOS Focus stored, and `null`
// stands in for Android, where the module is not registered.
vi.mock('expo', () => ({ requireOptionalNativeModule: mocks.requireOptionalNativeModule }));

vi.mock('expo-notifications', () => ({
  setBadgeCountAsync: mocks.setBadgeCountAsync,
  setNotificationChannelAsync: mocks.setNotificationChannelAsync,
  getNotificationChannelAsync: mocks.getNotificationChannelAsync,
  deleteNotificationChannelAsync: mocks.deleteNotificationChannelAsync,
  getPermissionsAsync: mocks.getPermissionsAsync,
  requestPermissionsAsync: mocks.requestPermissionsAsync,
  getExpoPushTokenAsync: mocks.getExpoPushTokenAsync,
  setNotificationHandler: mocks.setNotificationHandler,
  scheduleNotificationAsync: mocks.scheduleNotificationAsync,
  dismissNotificationAsync: mocks.dismissNotificationAsync,
  addNotificationResponseReceivedListener: (listener: ResponseListener) => {
    mocks.listeners.add(listener);
    return { remove: () => mocks.listeners.delete(listener) };
  },
  getLastNotificationResponse: () => mocks.lastResponse,
  clearLastNotificationResponse: mocks.clearLastNotificationResponse,
  registerTaskAsync: mocks.registerTaskAsync,
  BackgroundNotificationTaskResult: { NewData: 0, NoData: 1, Failed: 2 },
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
}));

vi.mock('expo-task-manager', () => ({
  defineTask: mocks.defineTask,
}));

// The s4 entry point builds the real mobile session manager (RN / tRPC graph),
// so the suite stubs the module the lazy dynamic import resolves to.
vi.mock('./notification-action-interaction', () => ({
  runNeedsInputInteraction: mocks.runNeedsInputInteraction,
}));

vi.mock('@sentry/react-native', () => ({
  captureException: mocks.captureException,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { eas: { projectId: 'proj-1' } } } },
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
  deleteItemAsync: mocks.deleteItemAsync,
}));

vi.mock('expo-widgets', async () => {
  const { after } = await import('expo-widgets/src/Widgets');
  return {
    after,
    addPushToStartTokenListener: (
      listener: (event: { activityPushToStartToken: string }) => void
    ) => {
      mocks.startTokenListeners.add(listener);
      return { remove: () => mocks.startTokenListeners.delete(listener) };
    },
  };
});

vi.mock('expo-widgets/src/ExpoWidgets', () => ({
  default: {
    LiveActivityFactory: class {
      getInstances = mocks.nativeInstances;
      start = vi.fn(() => {
        throw new Error('A remote activity must be adopted, not started locally');
      });
    },
  },
}));

vi.mock('@/glanceable-ios/active-agents-live-activity', async () => {
  // Keep the real expo-widgets wrapper between the sink and the native handles.
  const { LiveActivityFactory } = await import('expo-widgets/src/Widgets');
  return {
    ActiveAgentsLiveActivity: new LiveActivityFactory('ActiveAgentsLiveActivity', () => ({
      banner: null,
    })),
  };
});
vi.mock('@/glanceable-ios/active-agents-widget', () => ({
  ActiveAgentsWidget: { updateSnapshot: vi.fn(), updateTimeline: vi.fn() },
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    user: {
      registerActivityToken: { mutate: mocks.registerActivityToken },
      unregisterActivityToken: { mutate: mocks.unregisterActivityToken },
    },
  },
}));
vi.mock('@/lib/query-client', () => ({ queryClient: {} }));
vi.mock('@/lib/active-sessions-live-sync', () => ({
  refreshActiveSessionsFromPush: mocks.refreshActiveSessionsFromPush,
}));
vi.mock('@/lib/persist/read-cache', () => ({ readCachedUserId: () => null }));

vi.mock('@kilocode/notifications', async importOriginal => ({
  ...(await importOriginal<typeof Notifications>()),
  ANDROID_NOTIFICATION_CHANNELS: [
    { id: 'needs-input', name: 'Needs input', importance: 'high', bypassDnd: true },
    { id: 'agent-progress', name: 'Agent progress', importance: 'default', bypassDnd: false },
    { id: 'kiloclaw', name: 'KiloClaw activity', importance: 'default', bypassDnd: false },
    { id: 'balance', name: 'Balance alerts', importance: 'default', bypassDnd: false },
    { id: 'security', name: 'Security findings', importance: 'high', bypassDnd: false },
  ],
}));

vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: mocks.captureEvent,
}));

// Each test starts with fresh channel and pending-link state. Only native
// storage is replaced; payload parsing, mapping, and the pending slot are real.
async function loadNotifications() {
  vi.resetModules();
  const pending = await import('./deep-link-launch');
  pending._setSecureStoreForTests({
    setItemAsync: vi.fn().mockResolvedValue(undefined),
    deleteItemAsync: vi.fn().mockResolvedValue(undefined),
    getItemAsync: vi.fn().mockResolvedValue(null),
  });
  const [notifications, registry, persist] = await Promise.all([
    import('./notifications'),
    import('@/lib/glanceable/sink-registry'),
    import('@/lib/glanceable/persist'),
  ]);
  return { ...notifications, pending, persist, registry };
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
  mocks.appState.currentState = 'active';
  mocks.setBadgeCountAsync.mockResolvedValue(true);
  mocks.setNotificationChannelAsync.mockResolvedValue(undefined);
  mocks.scheduleNotificationAsync.mockResolvedValue(undefined);
  mocks.dismissNotificationAsync.mockResolvedValue(undefined);
  mocks.getNotificationChannelAsync.mockResolvedValue(null);
  mocks.deleteNotificationChannelAsync.mockResolvedValue(undefined);
  mocks.getPermissionsAsync.mockResolvedValue({ status: 'denied' });
  mocks.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });
  mocks.getExpoPushTokenAsync.mockResolvedValue({ data: 'expo-token' });
  mocks.requireOptionalNativeModule.mockReturnValue({ isAgentProgressAllowed: () => true });
  mocks.lastResponse = null;
  mocks.listeners.clear();
  mocks.clearLastNotificationResponse.mockImplementation(() => {
    mocks.lastResponse = null;
  });
});

describe('ensureAndroidNotificationChannels', () => {
  it('is a no-op on iOS', async () => {
    mocks.platform.OS = 'ios';
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await ensureAndroidNotificationChannels();

    expect(mocks.setNotificationChannelAsync).not.toHaveBeenCalled();
    expect(mocks.deleteNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it('creates the named channels with their names, importance, bypassDnd, and sound', async () => {
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await ensureAndroidNotificationChannels();

    expect(mocks.setNotificationChannelAsync.mock.calls).toEqual([
      ['needs-input', { name: 'Needs input', importance: 4, bypassDnd: true }],
      [
        'agent-progress',
        {
          name: 'Agent progress',
          importance: 3,
          bypassDnd: false,
          sound: null,
          enableVibrate: false,
        },
      ],
      ['kiloclaw', { name: 'KiloClaw activity', importance: 3, bypassDnd: false }],
      ['balance', { name: 'Balance alerts', importance: 3, bypassDnd: false }],
      ['security', { name: 'Security findings', importance: 4, bypassDnd: false }],
    ]);
  });

  it('silences only the progress channel so needs-input keeps the default sound', async () => {
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await ensureAndroidNotificationChannels();

    const optionsFor = (id: string): Record<string, unknown> | undefined =>
      mocks.setNotificationChannelAsync.mock.calls.find(call => call[0] === id)?.[1];
    // Android takes a channel-based post's sound from the channel, so the
    // progress kind must be silent here; an absent key is the default sound.
    // Vibration is a separate channel setting that defaults to enabled, so a
    // silent channel disables it explicitly.
    expect(optionsFor('agent-progress')).toMatchObject({ sound: null, enableVibrate: false });
    expect(optionsFor('needs-input')).not.toHaveProperty('sound');
    expect(optionsFor('needs-input')).not.toHaveProperty('enableVibrate');
  });

  it('deletes the three legacy channels on first creation', async () => {
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await ensureAndroidNotificationChannels();

    expect(mocks.deleteNotificationChannelAsync.mock.calls).toEqual([
      ['agent'],
      ['chat'],
      ['active-agents'],
    ]);
  });

  it('renames every channel with its translated name, bypassDnd, and sound', async () => {
    const { renameAndroidNotificationChannels } = await loadNotifications();

    await renameAndroidNotificationChannels();

    expect(mocks.setNotificationChannelAsync.mock.calls).toEqual([
      ['needs-input', { name: expect.any(String), importance: 4, bypassDnd: true }],
      [
        'agent-progress',
        {
          name: expect.any(String),
          importance: 3,
          bypassDnd: false,
          sound: null,
          enableVibrate: false,
        },
      ],
      ['kiloclaw', { name: expect.any(String), importance: 3, bypassDnd: false }],
      ['balance', { name: expect.any(String), importance: 3, bypassDnd: false }],
      ['security', { name: expect.any(String), importance: 4, bypassDnd: false }],
    ]);
    // Legacy deletion is part of the single-flight creation pass, not a rename.
    expect(mocks.deleteNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it('single-flights concurrent callers to one creation pass', async () => {
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    const first = ensureAndroidNotificationChannels();
    const second = ensureAndroidNotificationChannels();

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledTimes(5);
    expect(mocks.deleteNotificationChannelAsync).toHaveBeenCalledTimes(3);
  });

  it('swallows a per-channel failure and still creates the remaining channels', async () => {
    mocks.setNotificationChannelAsync.mockRejectedValueOnce(new Error('channel failed'));
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await expect(ensureAndroidNotificationChannels()).resolves.toBeUndefined();

    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledTimes(5);
    expect(mocks.deleteNotificationChannelAsync).toHaveBeenCalledTimes(3);
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        'error.subsystem': 'notifications',
        'error.operation': 'create_android_channel',
        'notification.channel': 'needs-input',
      },
    });
  });

  it('reports a legacy deletion failure without rejecting or skipping the remaining deletes', async () => {
    mocks.deleteNotificationChannelAsync.mockRejectedValueOnce(new Error('delete failed'));
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await expect(ensureAndroidNotificationChannels()).resolves.toBeUndefined();

    expect(mocks.deleteNotificationChannelAsync).toHaveBeenCalledTimes(3);
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        'error.subsystem': 'notifications',
        'error.operation': 'delete_android_channel',
        'notification.channel': 'agent',
      },
    });
  });

  it('retries every channel after a pass that failed one write', async () => {
    mocks.setNotificationChannelAsync.mockRejectedValueOnce(new Error('channel failed'));
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await ensureAndroidNotificationChannels();
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    mocks.setNotificationChannelAsync.mockClear();

    // A pass that failed a required channel is not cached: the next start
    // retries before it posts, and a channel the framework never created would
    // drop that post.
    await ensureAndroidNotificationChannels();
    expect(mocks.setNotificationChannelAsync.mock.calls.map(call => call[0])).toEqual([
      'needs-input',
      'agent-progress',
      'kiloclaw',
      'balance',
      'security',
    ]);

    // A fully successful pass is cached again.
    mocks.setNotificationChannelAsync.mockClear();
    await ensureAndroidNotificationChannels();
    expect(mocks.setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it('keeps a fully successful pass cached', async () => {
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await ensureAndroidNotificationChannels();
    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledTimes(5);
    mocks.setNotificationChannelAsync.mockClear();

    await ensureAndroidNotificationChannels();

    expect(mocks.setNotificationChannelAsync).not.toHaveBeenCalled();
  });
});

describe('planAndroidChannelWrite', () => {
  it('asks for the override while the user grants Do Not Disturb access', async () => {
    const { planAndroidChannelWrite } = await loadNotifications();

    expect(planAndroidChannelWrite(true, true)).toEqual({ bypassDnd: true });
  });

  it('stops asking for the override once the user revokes the access', async () => {
    const { planAndroidChannelWrite } = await loadNotifications();

    expect(planAndroidChannelWrite(true, false)).toEqual({ bypassDnd: false });
  });

  it('keeps asking when the access state is unreadable', async () => {
    const { planAndroidChannelWrite } = await loadNotifications();

    expect(planAndroidChannelWrite(true, null)).toEqual({ bypassDnd: true });
  });

  it('never asks for an override on a channel that does not want one', async () => {
    const { planAndroidChannelWrite } = await loadNotifications();

    expect(planAndroidChannelWrite(false, true)).toEqual({ bypassDnd: false });
    expect(planAndroidChannelWrite(false, false)).toEqual({ bypassDnd: false });
  });
});

describe('shouldRecreateAndroidChannel', () => {
  it('recreates only a channel still stored without the requested override', async () => {
    const { shouldRecreateAndroidChannel } = await loadNotifications();

    expect(shouldRecreateAndroidChannel(false, true)).toBe(true);
    expect(shouldRecreateAndroidChannel(true, true)).toBe(false);
    expect(shouldRecreateAndroidChannel(true, false)).toBe(false);
    expect(shouldRecreateAndroidChannel(false, false)).toBe(false);
  });

  it('never recreates an absent channel, which the write creates', async () => {
    const { shouldRecreateAndroidChannel } = await loadNotifications();

    expect(shouldRecreateAndroidChannel(null, true)).toBe(false);
    expect(shouldRecreateAndroidChannel(null, false)).toBe(false);
  });
});

describe('Android Do Not Disturb override reconciliation', () => {
  it('requests the override while the user still grants the access', async () => {
    mocks.requireOptionalNativeModule.mockReturnValue({
      isAgentProgressAllowed: () => true,
      isDndAccessGranted: () => true,
    });
    const { renameAndroidNotificationChannels } = await loadNotifications();

    await renameAndroidNotificationChannels();

    const needsInput = mocks.setNotificationChannelAsync.mock.calls.find(
      call => call[0] === 'needs-input'
    );
    expect(needsInput?.[1]).toMatchObject({ bypassDnd: true });
  });

  it('stops requesting the override while the user has revoked the access', async () => {
    mocks.requireOptionalNativeModule.mockReturnValue({
      isAgentProgressAllowed: () => true,
      isDndAccessGranted: () => false,
    });
    const { renameAndroidNotificationChannels } = await loadNotifications();

    await renameAndroidNotificationChannels();

    const needsInput = mocks.setNotificationChannelAsync.mock.calls.find(
      call => call[0] === 'needs-input'
    );
    expect(needsInput?.[1]).toMatchObject({ bypassDnd: false });
  });

  it('recreates a channel whose stored override differs, so the current grant applies', async () => {
    // Measured on API 35 (2026-09-17): the framework applies the access gate
    // only while it creates a channel and keeps the value it stored, so a write
    // to an existing channel never raises or lowers the override. A user who
    // granted access after the channel existed therefore gets the card to break
    // through Do Not Disturb only when the stale channel is recreated.
    mocks.requireOptionalNativeModule.mockReturnValue({
      isAgentProgressAllowed: () => true,
      isDndAccessGranted: () => true,
    });
    mocks.getNotificationChannelAsync.mockImplementation((channelId: string) =>
      channelId === 'needs-input' ? { id: 'needs-input', bypassDnd: false } : null
    );
    const { renameAndroidNotificationChannels } = await loadNotifications();

    await renameAndroidNotificationChannels();

    expect(mocks.deleteNotificationChannelAsync.mock.calls).toEqual([['needs-input']]);
    const needsInput = mocks.setNotificationChannelAsync.mock.calls.find(
      call => call[0] === 'needs-input'
    );
    expect(needsInput?.[1]).toMatchObject({ bypassDnd: true });
  });

  it('recreates a channel whose stored override survives a revoke', async () => {
    // The framework restores a deleted channel's stored override, so a recreate
    // cannot take the override back; a revoke needs none, because the framework
    // ignores a channel's override while the app holds no access. The delete
    // would only cost the user the ongoing card.
    mocks.requireOptionalNativeModule.mockReturnValue({
      isAgentProgressAllowed: () => true,
      isDndAccessGranted: () => false,
    });
    mocks.getNotificationChannelAsync.mockImplementation((channelId: string) =>
      channelId === 'needs-input' ? { id: 'needs-input', bypassDnd: true } : null
    );
    const { renameAndroidNotificationChannels } = await loadNotifications();

    await renameAndroidNotificationChannels();

    expect(mocks.deleteNotificationChannelAsync).not.toHaveBeenCalled();
    const needsInput = mocks.setNotificationChannelAsync.mock.calls.find(
      call => call[0] === 'needs-input'
    );
    expect(needsInput?.[1]).toMatchObject({ bypassDnd: false });
  });

  it('leaves a matching channel alone so the ongoing card is not dropped', async () => {
    mocks.requireOptionalNativeModule.mockReturnValue({
      isAgentProgressAllowed: () => true,
      isDndAccessGranted: () => true,
    });
    mocks.getNotificationChannelAsync.mockImplementation((channelId: string) =>
      channelId === 'needs-input' ? { id: 'needs-input', bypassDnd: true } : null
    );
    const { renameAndroidNotificationChannels } = await loadNotifications();

    await renameAndroidNotificationChannels();

    expect(mocks.deleteNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it('keeps the pre-existing request when the native access query is missing', async () => {
    mocks.requireOptionalNativeModule.mockReturnValue({ isAgentProgressAllowed: () => true });
    const { renameAndroidNotificationChannels } = await loadNotifications();

    await renameAndroidNotificationChannels();

    const needsInput = mocks.setNotificationChannelAsync.mock.calls.find(
      call => call[0] === 'needs-input'
    );
    expect(needsInput?.[1]).toMatchObject({ bypassDnd: true });
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

const securityResponses = ['personal', 'org-example'].flatMap(scope =>
  (
    [
      { type: 'security_finding' },
      { type: 'security_lifecycle', event: 'analysis_completed' },
    ] as const
  ).map(payload => ({
    data: { ...payload, scope, findingId: 'finding-123' } satisfies Notifications.PushData,
    path: `/(app)/(tabs)/(3_profile)/security-agent/${scope}/findings/finding-123?via=push`,
  }))
);
const responseCases = [
  {
    data: { type: 'chat.message', sandboxId: 's1', conversationId: 'c1', messageId: 'm1' },
    path: '/(app)/(tabs)/(1_kiloclaw)/chat/s1/c1?via=push',
  },
  ...securityResponses,
];

function deliverWarmResponse(response: Response) {
  for (const listener of mocks.listeners) {
    listener(response);
  }
}

describe.each(['cold', 'warm'])('%s notification responses', mode => {
  it.each(responseCases)(
    'stashes $data.type at $path once and removes the listener',
    async ({ data, path }) => {
      const { setupNotificationResponseHandler, checkInitialNotification, pending } =
        await loadNotifications();
      const response = { notification: { request: { content: { data } } } };
      mocks.lastResponse = response;
      const subscription = setupNotificationResponseHandler();

      if (mode === 'cold') {
        checkInitialNotification();
      } else {
        deliverWarmResponse(response);
      }

      expect(pending.getPendingDeepLinkSnapshot()).toBe(path);
      expect(mocks.lastResponse).toBeNull();
      expect(pending.getPendingDeepLink()).toBe(path);
      checkInitialNotification();
      expect(pending.getPendingDeepLinkSnapshot()).toBeNull();

      subscription.remove();
      deliverWarmResponse(response);
      expect(pending.getPendingDeepLinkSnapshot()).toBeNull();
    }
  );

  it.each([
    null,
    { type: 'security_finding', scope: 'personal' },
    { type: 'security_finding', scope: [], findingId: 'finding-invalid' },
    {
      type: 'security_lifecycle',
      event: 'unknown',
      scope: 'org-example',
      findingId: 'finding-invalid',
    },
  ])('preserves the pending destination for malformed data %j', async data => {
    const { setupNotificationResponseHandler, checkInitialNotification, pending } =
      await loadNotifications();
    const existing = '/(app)/(tabs)/(3_profile)';
    pending.setPendingDeepLink(existing, 'notification');
    const response = { notification: { request: { content: { data } } } };
    mocks.lastResponse = response;
    const subscription = setupNotificationResponseHandler();

    if (mode === 'cold') {
      checkInitialNotification();
    } else {
      deliverWarmResponse(response);
    }

    expect(pending.getPendingDeepLinkSnapshot()).toBe(existing);
    expect(mocks.lastResponse).toBe(mode === 'cold' ? null : response);
    subscription.remove();
  });
});

it.each([null, '/(app)/(tabs)/(3_profile)'])(
  'leaves pending destination %s unchanged without a last response',
  async destination => {
    const { checkInitialNotification, pending } = await loadNotifications();
    if (destination) {
      pending.setPendingDeepLink(destination, 'universal-link');
    }
    checkInitialNotification();
    expect(pending.getPendingDeepLinkSnapshot()).toBe(destination);
    expect(mocks.clearLastNotificationResponse).not.toHaveBeenCalled();
  }
);

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
    idle: 0,
    needsInputSince: '2026-01-01T00:00:00.000Z',
    newestResultKind: 'running',
    newestResultAt: '2026-01-01T00:00:00.000Z',
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
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStore.delete(key);
    await Promise.resolve();
  }),
};

describe('glanceable app badge sink', () => {
  async function loadBadgeSink() {
    const loaded = await loadNotifications();
    loaded._setGlanceableSinksLoaderForTests(() => undefined);
    loaded.setupNotificationBackgroundHandler();
    const [sink] = loaded.registry.getGlanceableSinks();
    if (!sink) {
      throw new Error('The app badge sink was not registered');
    }
    return { loaded, sink };
  }

  it('sets the needs-input count for a local happy snapshot', async () => {
    const { sink } = await loadBadgeSink();

    sink.publish(glanceableSnapshot({ needsInput: 3 }));
    await flushMicrotasks();

    expect(mocks.setBadgeCountAsync).toHaveBeenCalledWith(3);
  });

  it('keeps the stale count until a successful retry publishes a replacement', async () => {
    const { sink } = await loadBadgeSink();

    sink.publish(glanceableSnapshot({ needsInput: 3 }));
    sink.publish(glanceableSnapshot({ status: 'stale', needsInput: 3 }));
    sink.publish(glanceableSnapshot({ revision: 2, needsInput: 1 }));
    await flushMicrotasks();

    expect(mocks.setBadgeCountAsync.mock.calls).toEqual([[3], [3], [1]]);
  });

  it('leaves a push-set launcher badge alone across re-publications of the same count', async () => {
    const { sink } = await loadBadgeSink();

    // e7 baseline: a needs-input session published count 1 to the launcher.
    sink.publish(glanceableSnapshot({ needsInput: 1 }));
    await flushMicrotasks();
    expect(mocks.setBadgeCountAsync.mock.calls).toEqual([[1]]);

    // The OS then moves the launcher badge itself: a visible foreground push
    // with badge 2 is applied through the shouldSetBadge: true path. Every
    // tray refresh re-publishes the unchanged snapshot afterwards; none of
    // those re-publications may undo the badge the push carried.
    sink.publish(glanceableSnapshot({ revision: 2, needsInput: 1 }));
    sink.publish(glanceableSnapshot({ revision: 3, status: 'stale', needsInput: 1 }));
    await flushMicrotasks();
    expect(mocks.setBadgeCountAsync.mock.calls).toEqual([[1]]);

    // A real count change still reaches the launcher.
    sink.publish(glanceableSnapshot({ revision: 4, needsInput: 2 }));
    await flushMicrotasks();
    expect(mocks.setBadgeCountAsync.mock.calls).toEqual([[1], [2]]);
  });

  it.each([
    ['busy-only', { status: 'happy', running: 2, needsInput: 0 }],
    ['empty', { status: 'empty', running: 0, needsInput: 0, needsInputSince: null }],
    ['waiting', { status: 'waiting', running: 0, needsInput: 0, needsInputSince: null }],
    ['signed-out', { status: 'signed_out', running: 0, needsInput: 0, needsInputSince: null }],
    ['privacy', { status: 'privacy', running: 0, needsInput: 0, needsInputSince: null }],
  ] as const)('clears the badge for a %s snapshot', async (_label, overrides) => {
    const { sink } = await loadBadgeSink();

    sink.publish(glanceableSnapshot(overrides));
    await flushMicrotasks();

    expect(mocks.setBadgeCountAsync).toHaveBeenCalledWith(0);
  });

  it('serializes native writes so the newest count finishes last', async () => {
    const gate = deferred();
    mocks.setBadgeCountAsync
      .mockImplementationOnce(async () => {
        await gate.promise;
        return true;
      })
      .mockResolvedValue(true);
    const { sink } = await loadBadgeSink();

    sink.publish(glanceableSnapshot({ needsInput: 2 }));
    sink.publish(glanceableSnapshot({ revision: 2, needsInput: 7 }));
    expect(mocks.setBadgeCountAsync.mock.calls).toEqual([[2]]);

    gate.resolve();
    await flushMicrotasks();
    expect(mocks.setBadgeCountAsync.mock.calls).toEqual([[2], [7]]);
  });

  it('captures a failed write and continues with the next count', async () => {
    const error = new Error('badge write failed');
    mocks.setBadgeCountAsync.mockRejectedValueOnce(error).mockResolvedValue(true);
    const { sink } = await loadBadgeSink();

    sink.publish(glanceableSnapshot({ needsInput: 2 }));
    sink.publish(glanceableSnapshot({ revision: 2, needsInput: 5 }));
    await flushMicrotasks();

    expect(mocks.setBadgeCountAsync.mock.calls).toEqual([[2], [5]]);
    expect(mocks.captureException).toHaveBeenCalledWith(error, {
      tags: {
        'error.subsystem': 'notifications',
        'error.operation': 'set_glanceable_badge',
      },
    });
  });

  it('applies foreground glanceable counts and allows visible push badges', async () => {
    const { loaded } = await loadBadgeSink();
    loaded.persist._setLastGlanceableSnapshotForTests(glanceableSnapshot({ needsInput: 2 }));
    mockSecureStoreKeys();
    loaded.setupNotificationHandler();
    const registration = mocks.setNotificationHandler.mock.calls[0]?.[0] as {
      handleNotification: (notification: {
        request: { content: { data: unknown } };
      }) => Promise<{ shouldSetBadge: boolean }>;
    };

    const ordinary = await registration.handleNotification({
      request: {
        content: {
          data: {
            type: 'chat.message',
            sandboxId: 'sandbox-1',
            conversationId: 'conversation-1',
            messageId: 'message-1',
          },
        },
      },
    });
    expect(ordinary.shouldSetBadge).toBe(true);
    expect(mocks.setBadgeCountAsync).not.toHaveBeenCalled();

    const stale = await registration.handleNotification({
      request: {
        content: {
          data: activeGlanceablePush({
            updatedAt: '2025-12-31T00:00:00.000Z',
            needsInput: 9,
          }),
        },
      },
    });
    expect(stale.shouldSetBadge).toBe(false);
    expect(mocks.setBadgeCountAsync).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(mocks.setBadgeCountAsync).toHaveBeenCalledWith(2);
    mocks.setBadgeCountAsync.mockClear();

    const badgeWrite = deferred();
    mocks.setBadgeCountAsync.mockImplementation(async () => {
      await badgeWrite.promise;
      return true;
    });
    const handling = registration.handleNotification({
      request: {
        content: {
          data: activeGlanceablePush({
            updatedAt: '2026-01-02T00:00:00.000Z',
            needsInput: 4,
          }),
        },
      },
    });
    await flushMicrotasks();
    const completedBeforeWrite = await Promise.race([handling, Promise.resolve(null)]);
    badgeWrite.resolve();
    const glanceable = await handling;

    expect(glanceable.shouldSetBadge).toBe(true);
    expect(mocks.setBadgeCountAsync).toHaveBeenCalledWith(4);
    expect(mocks.refreshActiveSessionsFromPush).toHaveBeenCalledOnce();
    expect(completedBeforeWrite).toBeNull();
  });

  it('does not re-assert the local count when a later glanceable push is discarded', async () => {
    const { loaded } = await loadBadgeSink();
    loaded.persist._setLastGlanceableSnapshotForTests(glanceableSnapshot({ needsInput: 2 }));
    mockSecureStoreKeys();
    loaded.setupNotificationHandler();
    const registration = mocks.setNotificationHandler.mock.calls[0]?.[0] as {
      handleNotification: (notification: {
        request: { content: { data: unknown } };
      }) => Promise<{ shouldSetBadge: boolean }>;
    };

    // A fresh glanceable push confirms count 2 on the launcher through the sink.
    await registration.handleNotification({
      request: {
        content: {
          data: activeGlanceablePush({
            updatedAt: '2026-01-02T00:00:00.000Z',
            needsInput: 2,
          }),
        },
      },
    });
    await flushMicrotasks();
    expect(mocks.setBadgeCountAsync.mock.calls).toEqual([[2]]);

    // A visible push then moves the launcher itself (badge 3, shouldSetBadge).
    // A stale glanceable push is discarded: it carries no new count, so the
    // fallback must NOT re-write the unchanged local truth — that would undo
    // the badge the visible push carried (the e7 clobber).
    await registration.handleNotification({
      request: {
        content: {
          data: {
            type: 'chat.message',
            sandboxId: 'sandbox-1',
            conversationId: 'conversation-1',
            messageId: 'message-1',
          },
        },
      },
    });
    const stale = await registration.handleNotification({
      request: {
        content: {
          data: activeGlanceablePush({
            updatedAt: '2025-12-31T00:00:00.000Z',
            needsInput: 9,
          }),
        },
      },
    });
    expect(stale.shouldSetBadge).toBe(false);
    await flushMicrotasks();
    expect(mocks.setBadgeCountAsync.mock.calls).toEqual([[2]]);

    // A real count change still reaches the launcher after the discard.
    await registration.handleNotification({
      request: {
        content: {
          data: activeGlanceablePush({
            updatedAt: '2026-01-03T00:00:00.000Z',
            needsInput: 3,
          }),
        },
      },
    });
    await flushMicrotasks();
    expect(mocks.setBadgeCountAsync.mock.calls).toEqual([[2], [3]]);
  });
});

// The registered foreground handler, as `setupNotificationHandler` passes it to
// expo-notifications.
type ForegroundHandler = (notification: { request: { content: { data: unknown } } }) => Promise<{
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
  shouldShowBanner: boolean;
  shouldShowList: boolean;
}>;

async function loadForegroundHandler(): Promise<ForegroundHandler> {
  const loaded = await loadNotifications();
  loaded.setupNotificationHandler();
  const registration = mocks.setNotificationHandler.mock.calls[0]?.[0] as
    | { handleNotification: ForegroundHandler }
    | undefined;
  if (!registration) {
    throw new Error('The foreground notification handler was not registered');
  }
  return registration.handleNotification;
}

const SUPPRESSED_BEHAVIOR = {
  shouldPlaySound: false,
  shouldSetBadge: false,
  shouldShowBanner: false,
  shouldShowList: false,
};
const SHOWN_BEHAVIOR = {
  shouldPlaySound: true,
  shouldSetBadge: true,
  shouldShowBanner: true,
  shouldShowList: true,
};

const progressPush = {
  type: 'cloud_agent_session',
  cliSessionId: 'session-1',
  category: 'status',
};
const needsInputPush = {
  type: 'cloud_agent_session',
  cliSessionId: 'session-1',
  category: 'attention',
};

describe('per-Focus agent-progress suppression', () => {
  it('suppresses an agent-progress push on iOS when the active Focus excludes it', async () => {
    mocks.platform.OS = 'ios';
    mocks.requireOptionalNativeModule.mockReturnValue({ isAgentProgressAllowed: () => false });
    const handleNotification = await loadForegroundHandler();

    await expect(
      handleNotification({ request: { content: { data: progressPush } } })
    ).resolves.toEqual(SUPPRESSED_BEHAVIOR);
  });

  it('shows an agent-progress push on iOS when the active Focus allows it', async () => {
    mocks.platform.OS = 'ios';
    mocks.requireOptionalNativeModule.mockReturnValue({ isAgentProgressAllowed: () => true });
    const handleNotification = await loadForegroundHandler();

    await expect(
      handleNotification({ request: { content: { data: progressPush } } })
    ).resolves.toEqual(SHOWN_BEHAVIOR);
  });

  it('never suppresses a needs-input push, even when the Focus excludes progress', async () => {
    mocks.platform.OS = 'ios';
    mocks.requireOptionalNativeModule.mockReturnValue({ isAgentProgressAllowed: () => false });
    const handleNotification = await loadForegroundHandler();

    await expect(
      handleNotification({ request: { content: { data: needsInputPush } } })
    ).resolves.toEqual(SHOWN_BEHAVIOR);
  });

  it('shows an agent-progress push on Android, where the Focus module is absent', async () => {
    mocks.platform.OS = 'android';
    mocks.requireOptionalNativeModule.mockReturnValue(null);
    const handleNotification = await loadForegroundHandler();

    await expect(
      handleNotification({ request: { content: { data: progressPush } } })
    ).resolves.toEqual(SHOWN_BEHAVIOR);
  });

  it('never suppresses the glanceable carrier under an excluding Focus', async () => {
    mocks.platform.OS = 'ios';
    mocks.requireOptionalNativeModule.mockReturnValue({ isAgentProgressAllowed: () => false });
    const loaded = await loadNotifications();
    loaded.persist._setLastGlanceableSnapshotForTests(glanceableSnapshot({ needsInput: 2 }));
    mockSecureStoreKeys();
    loaded.setupNotificationHandler();
    const registration = mocks.setNotificationHandler.mock.calls[0]?.[0] as {
      handleNotification: ForegroundHandler;
    };

    // needsInput 0 is the progress kind, exactly what the Focus excluded; the
    // carrier must still reach the sinks instead of being dropped.
    const behavior = await registration.handleNotification({
      request: {
        content: {
          data: activeGlanceablePush({ updatedAt: '2026-01-02T00:00:00.000Z', needsInput: 0 }),
        },
      },
    });

    expect(behavior.shouldSetBadge).toBe(true);
    expect(mocks.refreshActiveSessionsFromPush).toHaveBeenCalledOnce();
  });
});

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
        idle: 0,
        needsInputSince: null,
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
        idle: 0,
        needsInputSince: null,
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
        idle: 0,
        needsInputSince: null,
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
              needsInputSince: running === 0 ? null : '2026-01-01T00:00:00.000Z',
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
    _setGlanceableSinksLoaderForTests(() => undefined);

    const sink = makeFakeSink();
    registerGlanceableSink(sink);

    setupNotificationBackgroundHandler();

    // Exactly one registered task name: the native side hands a notification
    // response to every registered consumer, so a second name would run an
    // Approve / Reply twice under the same needs-input identifier.
    expect(mocks.defineTask).toHaveBeenCalledTimes(1);
    expect(mocks.defineTask).toHaveBeenCalledWith(
      'active-agents-glanceable-background-task',
      expect.any(Function)
    );
    await flushMicrotasks();
    expect(mocks.registerTaskAsync).toHaveBeenCalledTimes(1);
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
              needsInput: 6,
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
    expect(mocks.setBadgeCountAsync).toHaveBeenCalledWith(6);

    unregisterGlanceableSink(sink);
  });

  it('keeps the background task alive until a zero-count badge write finishes', async () => {
    const persisted = glanceableSnapshot({
      scopeKey: SCOPE_KEY,
      revision: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      needsInput: 1,
    });
    secureStore.set('glanceable-snapshot', JSON.stringify(persisted));
    secureStore.set('glanceable-scope-key', SCOPE_KEY);
    _setGlanceableSinksLoaderForTests(() => undefined);
    const badgeWrite = deferred();
    mocks.setBadgeCountAsync.mockImplementation(async () => {
      await badgeWrite.promise;
      return true;
    });

    setupNotificationBackgroundHandler();
    const executor = executorFor(mocks.defineTask);
    let completed = false;
    const apply = async () => {
      const result = await executor({
        data: {
          notification: null,
          data: {
            dataString: JSON.stringify(
              activeGlanceablePush({
                scopeKey: SCOPE_KEY,
                updatedAt: '2026-01-02T00:00:00.000Z',
                status: 'empty',
                running: 0,
                needsInput: 0,
                idle: 0,
                needsInputSince: null,
              })
            ),
          },
        },
        error: null,
        executionInfo: {
          eventId: 'e-clear',
          taskName: 'active-agents-glanceable-background-task',
        },
      });
      completed = true;
      return result;
    };
    const applying = apply();
    await flushMicrotasks();

    expect(mocks.setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(completed).toBe(false);

    badgeWrite.resolve();
    expect(await applying).toBe(0);
  });

  it('ignores a headless payload that is not a glanceable push', async () => {
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

  it('dispatches a headless notification response to the needs-input action handler', async () => {
    const loaded = await loadNotifications();
    // The fresh module instance needs its own loader seam: the static-import
    // seam in the other tests belongs to a different instance.
    loaded._setGlanceableSinksLoaderForTests(() => undefined);
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');
    loaded.setupNotificationBackgroundHandler();
    const executor = executorFor(mocks.defineTask);
    const result = await executor({
      data: {
        actionIdentifier: 'kilo:approve',
        notification: {
          request: {
            identifier: 'fcm-remote-1',
            content: {
              title: 'Deploy',
              data: {
                type: 'cloud_agent_session',
                cliSessionId: 'ses_1',
                category: 'attention',
                attentionKind: 'permission',
              },
              categoryIdentifier: 'kilo-needs-input:permission',
            },
          },
        },
      },
      error: null,
      executionInfo: { eventId: 'e3', taskName: 'active-agents-glanceable-background-task' },
    });

    expect(mocks.runNeedsInputInteraction).toHaveBeenCalledWith({
      kiloSessionId: 'ses_1',
      action: 'approve',
    });
    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'needs-input:ses_1' })
    );
    expect(mocks.dismissNotificationAsync).toHaveBeenCalledWith('fcm-remote-1');
    // A handled action replaced its notification: NewData (0), not NoData (1).
    expect(result).toBe(0);
  });

  it('reports NoData for a headless body tap so iOS wakes stay throttled', async () => {
    const loaded = await loadNotifications();
    loaded._setGlanceableSinksLoaderForTests(() => undefined);
    loaded.setupNotificationBackgroundHandler();
    const executor = executorFor(mocks.defineTask);
    const result = await executor({
      data: {
        actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
        notification: {
          request: {
            identifier: 'fcm-remote-2',
            content: {
              data: {
                type: 'cloud_agent_session',
                cliSessionId: 'ses_1',
                category: 'attention',
                attentionKind: 'permission',
              },
            },
          },
        },
      },
      error: null,
      executionInfo: { eventId: 'e4', taskName: 'active-agents-glanceable-background-task' },
    });

    expect(result).toBe(1);
    expect(loaded.pending.getPendingDeepLinkSnapshot()).toBe('/(app)/agent-chat/ses_1?via=push');
  });
});

describe('foreground attention-push suppression', () => {
  async function loadHandler() {
    const loaded = await loadNotifications();
    // Imported through the same resetModules cycle as './notifications', so the
    // posted marker this test reads is the one the handler reads.
    const needsInput = await import('./needs-input-notification');
    loaded.setupNotificationHandler();
    const registration = mocks.setNotificationHandler.mock.calls[0]?.[0] as {
      handleNotification: (notification: {
        request: { identifier?: string; content: { data: unknown } };
      }) => Promise<{ shouldShowBanner: boolean; shouldSetBadge: boolean }>;
    };
    return { loaded, needsInput, registration };
  }

  const attentionPush = {
    type: 'cloud_agent_session',
    cliSessionId: 'ses_1',
    category: 'attention',
    attentionKind: 'permission',
  } as const;

  const postedRow = {
    sessionId: 'ses_1',
    title: 'Fix the bug',
    kind: 'permission',
    prUrl: null,
    organizationId: null,
  } as const;

  it('suppresses the server attention push while the app notification for that session is posted', async () => {
    const { needsInput, registration } = await loadHandler();

    await needsInput.applyNeedsInputNotifications({ publish: [postedRow], dismiss: [] });

    const behavior = await registration.handleNotification({
      request: { identifier: 'expo-push-remote-1', content: { data: attentionPush } },
    });
    expect(behavior.shouldShowBanner).toBe(false);
    expect(behavior.shouldSetBadge).toBe(false);
  });

  it('shows the app-owned needs-input notification even while its session is posted', async () => {
    const { needsInput, registration } = await loadHandler();

    await needsInput.applyNeedsInputNotifications({ publish: [postedRow], dismiss: [] });

    // The app's own post carries the same parsed payload as the server push;
    // suppressing it would drop the only notification the app presents.
    const behavior = await registration.handleNotification({
      request: {
        identifier: needsInput.notificationIdentifierForSession('ses_1'),
        content: { data: attentionPush },
      },
    });
    expect(behavior.shouldShowBanner).toBe(true);
    expect(behavior.shouldSetBadge).toBe(true);
  });

  it('shows the app-owned notification while the posted marker is not yet set', async () => {
    // The schedule resolves before the handler consults the posted marker, so
    // the app's own post must not depend on it.
    const { registration } = await loadHandler();

    const behavior = await registration.handleNotification({
      request: {
        identifier: 'needs-input:ses_1',
        content: { data: attentionPush },
      },
    });
    expect(behavior.shouldShowBanner).toBe(true);
  });

  it('shows the server attention push when the app notification is not posted', async () => {
    const { registration } = await loadHandler();

    const behavior = await registration.handleNotification({
      request: { content: { data: attentionPush } },
    });
    expect(behavior.shouldShowBanner).toBe(true);
  });

  it('shows the server attention push again after the raise is answered headless', async () => {
    const { needsInput, registration } = await loadHandler();
    await needsInput.applyNeedsInputNotifications({ publish: [postedRow], dismiss: [] });

    needsInput.clearPostedNeedsInputNotification('ses_1');

    const behavior = await registration.handleNotification({
      request: { content: { data: attentionPush } },
    });
    expect(behavior.shouldShowBanner).toBe(true);
  });

  it('shows an ordinary agent progress push even while the raise is posted', async () => {
    const { needsInput, registration } = await loadHandler();
    await needsInput.applyNeedsInputNotifications({ publish: [postedRow], dismiss: [] });

    const progress = await registration.handleNotification({
      request: {
        content: {
          data: { type: 'cloud_agent_session', cliSessionId: 'ses_1' },
        },
      },
    });
    expect(progress.shouldShowBanner).toBe(true);
  });
});

describe('cold iOS background delivery', () => {
  const rows = new Map<string, { kind: string; organizationId: string | null }>();
  const native = {
    id: 'remote-activity',
    exists: true,
    token: null as string | null,
    tokenRead: null as Promise<void> | null,
    updateRead: null as Promise<void> | null,
    endRead: null as Promise<void> | null,
    endError: null as Error | null,
    infoError: null as Error | null,
    dismissAt: null as number | null,
    props: null as string | null,
    contentDate: null as number | null,
    policies: [] as string[],
    // Counted at end() entry, before any gate: proves submission happened.
    endCalls: 0,
    observers: new Set<(token: string) => void>(),
  };

  function emitNativeToken(token: string): void {
    native.token = token;
    for (const observer of native.observers) {
      observer(token);
    }
  }

  async function loadColdBackground() {
    vi.resetModules();
    await import('@/lib/glanceable/delivery-registration');
    const [notifications, registry, persist, sink, cleanup, blank, waitingAsk] = await Promise.all([
      import('./notifications'),
      import('@/lib/glanceable/sink-registry'),
      import('@/lib/glanceable/persist'),
      import('@/glanceable-ios/ios-sink'),
      import('@/lib/auth/logout-cleanup'),
      import('@/lib/glanceable/cleanup'),
      import('@/lib/glanceable/waiting-ask'),
    ]);
    persist._setSecureStoreForTests(secureStoreMock);
    // The ask mirror lazy-`require`s the native store too, so the headless
    // hydration reads the same injected map the snapshot restore does.
    waitingAsk._setSecureStoreForTests(secureStoreMock);
    for (const listener of mocks.startTokenListeners) {
      listener({ activityPushToStartToken: 'scope-token' });
    }
    notifications._setGlanceableSinksLoaderForTests(() => {
      registry.registerGlanceableSink(persist.persistGlanceableSink);
      registry.registerGlanceableSink(sink.iosSink);
    });
    notifications.setupNotificationBackgroundHandler();
    const executor = mocks.defineTask.mock.calls[0]?.[1] as (body: {
      data: { notification: null; data: { dataString: string } };
      error: null;
      executionInfo: { eventId: string; taskName: string };
    }) => Promise<number>;
    return {
      cleanup,
      blank,
      sink,
      deliver: async (overrides: Partial<GlanceableAgentsSnapshot>) => {
        const result = await executor({
          data: {
            notification: null,
            data: {
              dataString: JSON.stringify(
                activeGlanceablePush({ updatedAt: '2026-01-02T00:00:00.000Z', ...overrides })
              ),
            },
          },
          error: null,
          executionInfo: { eventId: 'cold', taskName: 'active-agents-glanceable-background-task' },
        });
        return result;
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.platform.OS = 'ios';
    mocks.startTokenListeners.clear();
    mocks.defineTask.mockReset();
    mocks.registerTaskAsync.mockResolvedValue(null);
    secureStore.clear();
    secureStore.set('glanceable-snapshot', JSON.stringify(glanceableSnapshot()));
    secureStore.set('glanceable-scope-key', SCOPE_KEY);
    secureStore.set(ACTIVE_USER_ID_KEY, 'u1');
    secureStore.set(ORGANIZATION_STORAGE_KEY, 'org-9');
    mocks.getItemAsync.mockImplementation(secureStoreMock.getItemAsync);
    mocks.setItemAsync.mockImplementation(secureStoreMock.setItemAsync);
    mocks.deleteItemAsync.mockImplementation(async (key: string) => {
      await Promise.resolve();
      secureStore.delete(key);
    });
    rows.clear();
    rows.set('scope-token', { kind: 'ios_push_to_start', organizationId: 'org-9' });
    mocks.registerActivityToken.mockImplementation(
      async ({
        token,
        kind,
        organizationId,
      }: {
        token: string;
        kind: string;
        organizationId: string | null;
      }) => {
        await Promise.resolve();
        rows.set(token, { kind, organizationId });
        return { success: true };
      }
    );
    mocks.unregisterActivityToken.mockImplementation(async ({ token }: { token: string }) => {
      await Promise.resolve();
      rows.delete(token);
      return { success: true };
    });
    native.id = 'remote-activity';
    native.exists = true;
    native.token = null;
    native.tokenRead = null;
    native.updateRead = null;
    native.endRead = null;
    native.endError = null;
    native.infoError = null;
    native.dismissAt = null;
    native.props = null;
    native.contentDate = null;
    native.policies = [];
    native.endCalls = 0;
    native.observers.clear();
    mocks.nativeInstances.mockImplementation((includeEnded = false) => {
      if (
        !native.exists &&
        (!includeEnded || native.dismissAt === null || native.dismissAt <= Date.now())
      ) {
        return [];
      }
      const id = native.id;
      const isDismissed = () =>
        id !== native.id ||
        (!native.exists && (native.dismissAt === null || native.dismissAt <= Date.now()));
      const listeners = new Set<(event: { activityId: string; pushToken: string }) => void>();
      // Model native adoption and retained end handles; the JS adapter remains real.
      native.observers.add(token => {
        for (const listener of listeners) {
          listener({ activityId: id, pushToken: token });
        }
      });
      return [
        {
          getInfo: () => {
            if (native.infoError !== null) {
              throw native.infoError;
            }
            if (isDismissed()) {
              return { id, state: 'dismissed' };
            }
            return { id, state: native.exists ? 'active' : 'ended' };
          },
          getPushToken: async () => {
            await native.tokenRead;
            if (!native.exists || id !== native.id) {
              throw new Error('Activity no longer exists');
            }
            return native.token;
          },
          addListener: (
            name: string,
            listener: (event: { activityId: string; pushToken: string }) => void
          ) => {
            if (name !== 'onExpoWidgetsTokenReceived') {
              throw new Error('Unknown native event');
            }
            listeners.add(listener);
            return { remove: () => listeners.delete(listener) };
          },
          update: async (props: string) => {
            await native.updateRead;
            if (!isDismissed()) {
              native.props = props;
            }
          },
          // eslint-disable-next-line max-params -- match the installed expo-widgets native end contract
          end: async (policy: string, afterDate?: number, props?: string, contentDate?: number) => {
            native.endCalls += 1;
            await native.endRead;
            if (isDismissed()) {
              throw Object.assign(new Error('Live Activity not found'), {
                code: 'ERR_LIVE_ACTIVITY_NOT_FOUND',
              });
            }
            if (native.endError !== null) {
              throw native.endError;
            }
            native.exists = false;
            native.dismissAt = policy === 'after' ? (afterDate ?? null) : Date.now();
            native.props = props ?? null;
            native.contentDate = contentDate ?? null;
            native.policies.push(policy);
            native.observers.clear();
          },
        },
      ];
    });
  });

  afterEach(() => {
    native.observers.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(['dismissed', 'missing'] as const)(
    'completes fresh background terminal work after a %s target during a pending update',
    async absence => {
      const update = deferred();
      native.updateRead = update.promise;
      const background = await loadColdBackground();
      expect(await background.deliver({ running: 2 })).toBe(0);
      const applying = background.deliver({
        updatedAt: '2026-01-02T00:00:01.000Z',
        status: 'empty',
        running: 0,
        needsInputSince: null,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(native.policies).toEqual([]);

      native.exists = false;
      native.dismissAt = absence === 'dismissed' ? Date.now() : null;
      update.resolve();
      const earlierResults = await Promise.allSettled([applying]);

      native.id = 'fresh-activity';
      native.exists = true;
      native.dismissAt = null;
      native.updateRead = null;
      expect(await background.deliver({ updatedAt: '2026-01-02T00:00:02.000Z', running: 3 })).toBe(
        0
      );
      expect(JSON.parse(native.props ?? '{}')).toMatchObject({ status: 'happy', running: 3 });
      await expect(
        background.deliver({
          updatedAt: '2026-01-02T00:00:03.000Z',
          status: 'empty',
          running: 0,
          needsInputSince: null,
        })
      ).resolves.toBe(0);

      expect(native.exists).toBe(false);
      expect(native.policies).toEqual(['after']);
      expect(native.dismissAt).toBe(Date.now() + 8000);
      expect(JSON.parse(native.props ?? '{}')).toMatchObject({ status: 'empty', running: 0 });
      expect(earlierResults).toEqual([{ status: 'fulfilled', value: 0 }]);
    }
  );

  it.each(['active', 'ended', 'unavailable'] as const)(
    'rejects and retries a native end failure when the target state is %s',
    async state => {
      const background = await loadColdBackground();
      expect(await background.deliver({ running: 2 })).toBe(0);
      const end = deferred();
      native.endRead = end.promise;
      native.endError = new Error('Native end temporarily unavailable');
      const applying = background.deliver({
        updatedAt: '2026-01-02T00:00:01.000Z',
        status: 'empty',
        running: 0,
        needsInputSince: null,
      });
      const rejected = expect(applying).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      background.sink.iosSink.endImmediate();
      if (state === 'ended') {
        native.exists = false;
        native.dismissAt = Date.now() + 8000;
      }
      if (state === 'unavailable') {
        native.infoError = new Error('Native state temporarily unavailable');
      }
      end.resolve();
      await rejected;
      expect(native.policies).toEqual([]);
      expect(JSON.parse(native.props ?? '{}')).toMatchObject({ running: 2 });

      native.endError = null;
      native.infoError = null;
      native.endRead = null;
      // Remotely ended content is absent from eligible discovery, but still needs cleanup.
      native.exists = false;
      native.dismissAt = Date.now() + 8000;
      await expect(
        background.deliver({
          updatedAt: '2026-01-02T00:00:02.000Z',
          status: 'empty',
          running: 0,
          needsInputSince: null,
        })
      ).resolves.toBe(0);
      expect(native.policies).toEqual(['immediate']);
      expect(native.dismissAt).toBe(Date.now());
    }
  );

  it('registers late and rotated tokens from an adopted native handle through the real widget wrapper', async () => {
    const background = await loadColdBackground();
    expect(await background.deliver({})).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(rows.size).toBe(1);

    emitNativeToken('late-activity-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(rows.get('late-activity-token')).toEqual({
      kind: 'ios_activity',
      organizationId: 'org-9',
    });
    emitNativeToken('rotated-activity-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(rows.get('rotated-activity-token')).toEqual({
      kind: 'ios_activity',
      organizationId: 'org-9',
    });

    await background.cleanup.unregisterActivityTokensAndTombstone();
    emitNativeToken('after-cleanup');
    await vi.advanceTimersByTimeAsync(0);
    expect(rows.size).toBe(0);
  });

  it('captures the cold idle token before native end and preserves scope delivery without awaiting the network', async () => {
    native.token = 'ended-activity-token';
    rows.set(native.token, { kind: 'ios_activity', organizationId: 'org-9' });
    const read = deferred();
    const deletion = deferred();
    native.tokenRead = read.promise;
    mocks.unregisterActivityToken.mockImplementation(async ({ token }: { token: string }) => {
      await deletion.promise;
      rows.delete(token);
      return { success: true };
    });
    const background = await loadColdBackground();
    const applying = background.deliver({ status: 'empty', running: 0, needsInputSince: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(native.exists).toBe(true);
    read.resolve();
    expect(await applying).toBe(0);
    expect(native.exists).toBe(false);
    expect(native.policies).toEqual(['after']);
    expect(native.dismissAt).toBe(Date.now() + 8000);
    expect(rows.has('ended-activity-token')).toBe(true);

    deletion.resolve();
    await background.cleanup.awaitActivityCleanupSettled();
    expect(rows).toEqual(
      new Map([['scope-token', { kind: 'ios_push_to_start', organizationId: 'org-9' }]])
    );
    expect(await background.cleanup.readLogoutCleanupTombstone()).toBeNull();
  });

  it('waits for the real adapter to submit the native deadline before background completion', async () => {
    vi.setSystemTime(Date.parse('2026-01-02T00:00:00.000Z'));
    const end = deferred();
    native.endRead = end.promise;
    const background = await loadColdBackground();
    let completed = false;
    const apply = async () => {
      const result = await background.deliver({
        status: 'empty',
        running: 0,
        needsInputSince: null,
      });
      completed = true;
      return result;
    };
    const applying = apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);
    expect(native.policies).toEqual([]);

    end.resolve();
    expect(await applying).toBe(0);
    expect(native.policies).toEqual(['after']);
    expect(native.dismissAt).toBe(Date.parse('2026-01-02T00:00:08.000Z'));
    expect(native.contentDate).toBe(Date.parse('2026-01-02T00:00:00.000Z'));
    expect(JSON.parse(native.props ?? '{}')).toEqual({
      status: 'empty',
      running: 0,
      needsInput: 0,
      needsApproval: 0,
      idle: 0,
      needsInputSince: null,
      // No ask is recorded for this cold push, so the app-built state says so
      // explicitly; the layout gates Approve on this flag.
      canApprove: false,
    });
    expect(rows.has('scope-token')).toBe(true);
  });

  it('hydrates the mirrored ask so a waiting push keeps Approve', async () => {
    // The app is not running, so the only copy of the ask is the SecureStore
    // mirror. The headless apply must read it before the sink stamps
    // `canApprove`, or the card hides an Approve that the tap still answers.
    secureStore.set(
      'glanceable-waiting-ask',
      JSON.stringify({
        kiloSessionId: 'session-1',
        status: 'permission',
        isCloudAgent: true,
        scopeKey: SCOPE_KEY,
        organizationId: 'org-9',
        userId: 'u1',
        recordedAt: Date.parse('2026-01-01T00:00:00.000Z'),
      })
    );
    const background = await loadColdBackground();
    expect(
      await background.deliver({
        status: 'happy',
        running: 0,
        needsInput: 1,
        idle: 0,
        needsInputSince: '2026-01-01T00:00:00.000Z',
      })
    ).toBe(0);

    expect(JSON.parse(native.props ?? '{}')).toMatchObject({ needsInput: 1, canApprove: true });
  });

  it('does not revive a mirrored ask recorded for another scope', async () => {
    // The mirror outlives a sign-out or an org switch, and the ask names the
    // session and organization an action would answer: a restored record from
    // another scope must never put Approve on the card.
    secureStore.set(
      'glanceable-waiting-ask',
      JSON.stringify({
        kiloSessionId: 'session-1',
        status: 'permission',
        isCloudAgent: true,
        scopeKey: buildOpaqueScopeKey({ userId: 'u1', organizationId: 'org-other' }),
        organizationId: 'org-other',
        userId: 'u1',
        recordedAt: Date.parse('2026-01-01T00:00:00.000Z'),
      })
    );
    const background = await loadColdBackground();
    expect(
      await background.deliver({
        status: 'happy',
        running: 0,
        needsInput: 1,
        idle: 0,
        needsInputSince: '2026-01-01T00:00:00.000Z',
      })
    ).toBe(0);

    expect(JSON.parse(native.props ?? '{}')).toMatchObject({ needsInput: 1, canApprove: false });
  });

  it('keeps the adopted card when an idle-only push arrives in the background', async () => {
    vi.setSystemTime(Date.parse('2026-01-02T00:00:00.000Z'));
    mocks.appState.currentState = 'background';
    const background = await loadColdBackground();
    expect(
      await background.deliver({
        status: 'happy',
        running: 0,
        needsInput: 0,
        idle: 1,
        needsInputSince: null,
      })
    ).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(native.endCalls).toBe(0);
    expect(native.exists).toBe(true);
    expect(JSON.parse(native.props ?? '{}')).toMatchObject({ status: 'happy', idle: 1 });
  });

  it('immediately dismisses an ended adopted handle and rejects old-scope work after privacy', async () => {
    const background = await loadColdBackground();
    expect(await background.deliver({ status: 'empty', running: 0, needsInputSince: null })).toBe(
      0
    );
    expect(native.dismissAt).toBe(Date.now() + 8000);
    background.blank.writePrivacySnapshotAndEnd();
    await background.sink.iosSink.waitForNativeTerminal?.();
    await background.cleanup.awaitActivityCleanupSettled();

    expect(native.policies).toEqual(['after', 'immediate']);
    expect(native.dismissAt).toBe(Date.now());
    expect(JSON.parse(native.props ?? '{}')).toMatchObject({ status: 'privacy', running: 0 });
    emitNativeToken('late-old-token');
    expect(await background.deliver({ running: 7 })).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(rows.size).toBe(0);
    expect(JSON.parse(native.props ?? '{}')).toMatchObject({ status: 'privacy', running: 0 });
  });

  it('orders privacy after an already-submitted terminal end without restoring terminal content', async () => {
    const end = deferred();
    native.endRead = end.promise;
    const background = await loadColdBackground();
    const applying = background.deliver({ status: 'empty', running: 0, needsInputSince: null });
    await vi.advanceTimersByTimeAsync(0);
    background.blank.writeSignedOutSnapshotAndEnd();
    end.resolve();
    expect(await applying).toBe(0);
    await background.sink.iosSink.waitForNativeTerminal?.();

    expect(native.policies).toEqual(['after', 'immediate']);
    expect(native.dismissAt).toBe(Date.now());
    expect(JSON.parse(native.props ?? '{}')).toMatchObject({ status: 'signed_out', running: 0 });
  });

  it('tombstones only the failed cold idle token after native discovery disappears', async () => {
    native.token = 'failed-activity-token';
    rows.set(native.token, { kind: 'ios_activity', organizationId: 'org-9' });
    mocks.unregisterActivityToken.mockRejectedValueOnce(new Error('network unavailable'));
    const background = await loadColdBackground();
    expect(await background.deliver({ status: 'empty', running: 0, needsInputSince: null })).toBe(
      0
    );
    await background.cleanup.awaitActivityCleanupSettled();
    await vi.advanceTimersByTimeAsync(0);

    expect(native.exists).toBe(false);
    expect(rows.has('scope-token')).toBe(true);
    expect(rows.has('failed-activity-token')).toBe(true);
    expect(await background.cleanup.readLogoutCleanupTombstone()).toMatchObject({
      userId: null,
      needsPushUnregister: false,
      needsActivityUnregister: true,
      activityTokens: ['failed-activity-token'],
    });
    const { attemptLogoutReconciliation } = await import('@/lib/auth/logout-reconciliation');
    await attemptLogoutReconciliation('u1');
    expect(rows).toEqual(
      new Map([['scope-token', { kind: 'ios_push_to_start', organizationId: 'org-9' }]])
    );
    expect(await background.cleanup.readLogoutCleanupTombstone()).toBeNull();
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
