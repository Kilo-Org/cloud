import expoConstants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { type Href, router } from 'expo-router';
import { Platform } from 'react-native';
import { z } from 'zod';

import { type PushData, pushDataSchema } from '@kilocode/notifications';

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
  shouldShowAlert: true,
  shouldPlaySound: true,
  shouldSetBadge: true,
  shouldShowBanner: true,
  shouldShowList: true,
} satisfies Notifications.NotificationBehavior;

const suppressed = {
  shouldShowAlert: false,
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

// Pending deep link from a notification tap (cold start or background).
// Consumed by the root nav after auth/navigation is ready.
let pendingNotificationLink: string | null = null;

export function getPendingNotificationLink(): string | null {
  const link = pendingNotificationLink;
  pendingNotificationLink = null;
  return link;
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
    try {
      router.replace(path as Href);
    } catch {
      pendingNotificationLink = path;
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
    pendingNotificationLink = notificationPathForData(data);
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
