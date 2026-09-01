import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Notifications from '@kilocode/notifications';

type Response = { notification: { request: { content: { data: unknown } } } };
type ResponseListener = (response: Response) => void;

const mocks = vi.hoisted(() => ({
  platform: { OS: 'android' as string },
  setNotificationChannelAsync: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  captureException: vi.fn(),
  lastResponse: null as Response | null,
  listeners: new Set<ResponseListener>(),
  clearLastNotificationResponse: vi.fn(),
  captureEvent: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
}));

vi.mock('expo-notifications', () => ({
  setNotificationChannelAsync: mocks.setNotificationChannelAsync,
  getPermissionsAsync: mocks.getPermissionsAsync,
  requestPermissionsAsync: mocks.requestPermissionsAsync,
  getExpoPushTokenAsync: mocks.getExpoPushTokenAsync,
  setNotificationHandler: vi.fn(),
  addNotificationResponseReceivedListener: (listener: ResponseListener) => {
    mocks.listeners.add(listener);
    return { remove: () => mocks.listeners.delete(listener) };
  },
  getLastNotificationResponse: () => mocks.lastResponse,
  clearLastNotificationResponse: mocks.clearLastNotificationResponse,
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
}));

vi.mock('@sentry/react-native', () => ({
  captureException: mocks.captureException,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { eas: { projectId: 'proj-1' } } } },
}));

vi.mock('@kilocode/notifications', async importOriginal => ({
  ...(await importOriginal<typeof Notifications>()),
  ANDROID_NOTIFICATION_CHANNELS: [
    { id: 'agent', name: 'Agent sessions', importance: 'high' },
    { id: 'chat', name: 'Chat messages', importance: 'high' },
    { id: 'balance', name: 'Balance alerts', importance: 'default' },
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
  return { ...(await import('./notifications')), pending };
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
  });

  it('creates every channel on Android with the mapped importance', async () => {
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await ensureAndroidNotificationChannels();

    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledTimes(3);
    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledWith('agent', {
      name: 'Agent sessions',
      importance: 4,
    });
    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledWith('chat', {
      name: 'Chat messages',
      importance: 4,
    });
    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledWith('balance', {
      name: 'Balance alerts',
      importance: 3,
    });
  });

  it('single-flights concurrent callers to one creation pass', async () => {
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    const first = ensureAndroidNotificationChannels();
    const second = ensureAndroidNotificationChannels();

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledTimes(3);
  });

  it('swallows a per-channel failure and still creates the remaining channels', async () => {
    mocks.setNotificationChannelAsync.mockRejectedValueOnce(new Error('channel failed'));
    const { ensureAndroidNotificationChannels } = await loadNotifications();

    await expect(ensureAndroidNotificationChannels()).resolves.toBeUndefined();

    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledTimes(3);
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
