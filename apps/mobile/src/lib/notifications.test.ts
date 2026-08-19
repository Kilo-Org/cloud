import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const platform = { OS: 'android' as string };
  return {
    platform,
    setNotificationChannelAsync: vi.fn(),
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
    captureException: vi.fn(),
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
  addNotificationResponseReceivedListener: vi.fn(),
  getLastNotificationResponse: vi.fn(),
  clearLastNotificationResponse: vi.fn(),
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
}));

vi.mock('@sentry/react-native', () => ({
  captureException: mocks.captureException,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { eas: { projectId: 'proj-1' } } } },
}));

vi.mock('expo-router', () => ({
  router: { navigate: vi.fn() },
}));

vi.mock('@kilocode/notifications', () => ({
  ANDROID_NOTIFICATION_CHANNELS: [
    { id: 'agent', name: 'Agent sessions', importance: 'high' },
    { id: 'chat', name: 'Chat messages', importance: 'high' },
    { id: 'balance', name: 'Balance alerts', importance: 'default' },
  ],
  pushDataSchema: { safeParse: () => ({ success: false }) },
}));

vi.mock('@/lib/deep-link-launch', () => ({
  setPendingDeepLink: vi.fn(),
}));

vi.mock('@/lib/notification-path', () => ({
  notificationPathForData: vi.fn(),
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
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
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
