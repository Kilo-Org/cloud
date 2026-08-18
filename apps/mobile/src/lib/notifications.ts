import expoConstants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { type Href, router } from 'expo-router';
import { Platform } from 'react-native';
import { z } from 'zod';

import { type PushData, pushDataSchema } from '@kilocode/notifications';

import { setPendingDeepLink } from './deep-link-launch';
import { notificationPathForData } from './notification-path';

const easConfigSchema = z.object({ projectId: z.string().min(1) });

function getProjectId(): string {
  const parsed = easConfigSchema.safeParse(expoConstants.expoConfig?.extra?.eas);
  if (!parsed.success) {
    throw new Error('Missing extra.eas.projectId in app config');
  }
  return parsed.data.projectId;
}

// Tracks which conversation screen is currently focused.
// Read by the foreground notification handler to suppress notifications
// when the user is already viewing that conversation.
// A module-level variable (not React state) because the notification handler
// is registered once and must always read the latest value without stale closures.
let activeChatLocation: { sandboxId: string; conversationId: string } | null = null;

export function setActiveChatLocation(
  location: { sandboxId: string; conversationId: string } | null
) {
  activeChatLocation = location;
}

// Runtime-validates that an arbitrary notification `data` payload matches the
// shape we care about. Push producers can evolve independently of the app, so
// always parse before reading fields from the OS-provided notification content.
export function parseNotificationData(data: unknown): PushData | null {
  const parsed = pushDataSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

const shown = {
  shouldPlaySound: true,
  shouldSetBadge: true,
  shouldShowBanner: true,
  shouldShowList: true,
} satisfies Notifications.NotificationBehavior;

const suppressed = {
  shouldPlaySound: false,
  shouldSetBadge: false,
  shouldShowBanner: false,
  shouldShowList: false,
} satisfies Notifications.NotificationBehavior;

export function setupNotificationHandler() {
  Notifications.setNotificationHandler({
    // eslint-disable-next-line require-await -- expo-notifications requires async callback type but logic is synchronous
    handleNotification: async notification => {
      const data = parseNotificationData(notification.request.content.data);

      if (
        data?.type === 'chat.message' &&
        activeChatLocation?.sandboxId === data.sandboxId &&
        activeChatLocation.conversationId === data.conversationId
      ) {
        return suppressed;
      }
      return shown;
    },
  });
}

export function setupNotificationResponseHandler() {
  const subscription = Notifications.addNotificationResponseReceivedListener(response => {
    const data = parseNotificationData(response.notification.request.content.data);
    if (!data) {
      return;
    }

    const path = notificationPathForData(data);
    Notifications.clearLastNotificationResponse();
    // If the router is ready, navigate immediately; otherwise store as pending.
    // navigate (not replace) so the target screen keeps a back stack — replace
    // on a stack root leaves canGoBack() false and strands the user — while
    // still deduplicating if the route is already on top.
    try {
      router.navigate(path as Href);
    } catch {
      setPendingDeepLink(path, 'notification');
    }
  });

  return subscription;
}

// Check for notification that launched the app (cold start)
export function checkInitialNotification(): void {
  const response = Notifications.getLastNotificationResponse();
  if (!response) {
    return;
  }
  const data = parseNotificationData(response.notification.request.content.data);
  if (data) {
    setPendingDeepLink(notificationPathForData(data), 'notification');
  }
  Notifications.clearLastNotificationResponse();
}

export async function registerForPushNotifications(): Promise<string | null> {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();

  let finalStatus = existingStatus;
  if (existingStatus !== Notifications.PermissionStatus.GRANTED) {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== Notifications.PermissionStatus.GRANTED) {
    return null;
  }

  const tokenResponse = await Notifications.getExpoPushTokenAsync({
    projectId: getProjectId(),
  });

  return tokenResponse.data;
}

/**
 * The stable per-device Expo push token, or null when the permission is not
 * granted (denied or undetermined), so the device never obtained a token this
 * install. Rejects when either expo call throws — the caller decides how to
 * treat a failed lookup.
 */
export async function getDevicePushToken(): Promise<string | null> {
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== Notifications.PermissionStatus.GRANTED) {
    return null;
  }

  const tokenResponse = await Notifications.getExpoPushTokenAsync({
    projectId: getProjectId(),
  });
  return tokenResponse.data;
}

export type DevicePushTokenOutcome =
  | { kind: 'none' }
  | { kind: 'token'; token: string }
  | { kind: 'lookup-failed' };

/**
 * Three-outcome device push token read for sign-out cleanup. `'none'` means
 * the permission is not granted (denied or undetermined), so the device never
 * obtained a token this install and there is nothing to unregister. `'token'`
 * is the stable per-device Expo push token. `'lookup-failed'` means either
 * expo call threw, so a server row may exist and reconciliation must re-read.
 */
export async function getDevicePushTokenOutcome(): Promise<DevicePushTokenOutcome> {
  try {
    const token = await getDevicePushToken();
    return token === null ? { kind: 'none' } : { kind: 'token', token };
  } catch {
    return { kind: 'lookup-failed' };
  }
}

export async function getNotificationPermissionStatus(): Promise<
  'granted' | 'denied' | 'undetermined'
> {
  const { status } = await Notifications.getPermissionsAsync();
  return status;
}

export function getPlatform(): 'ios' | 'android' {
  if (Platform.OS === 'ios') {
    return 'ios';
  }
  if (Platform.OS === 'android') {
    return 'android';
  }

  throw new Error('Unsupported platform for push notifications');
}
