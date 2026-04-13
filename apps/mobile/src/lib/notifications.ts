import expoConstants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { type Href, router } from 'expo-router';
import { Platform } from 'react-native';

function getProjectId(): string {
  const eas = expoConstants.expoConfig?.extra?.eas as { projectId?: string } | undefined;
  const projectId = eas?.projectId;
  if (!projectId) {
    throw new Error('Missing extra.eas.projectId in app config');
  }
  return projectId;
}

// Tracks which chat instance screen is currently focused.
// Read by the foreground notification handler to suppress notifications
// when the user is already viewing that chat.
// A module-level variable (not React state) because the notification handler
// is registered once and must always read the latest value without stale closures.
let activeChatInstanceId: string | null = null;

export function setActiveChatInstance(instanceId: string | null) {
  activeChatInstanceId = instanceId;
}

// Keep in sync with data field in services/notifications/src/dos/NotificationChannelDO.ts
export type NotificationData = { type: 'chat'; instanceId: string };

const shown = {
  shouldShowAlert: true,
  shouldPlaySound: true,
  shouldSetBadge: true,
  shouldShowBanner: true,
  shouldShowList: true,
} as const;

const suppressed = {
  shouldShowAlert: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
  shouldShowBanner: false,
  shouldShowList: false,
} as const;

export function setupNotificationHandler() {
  Notifications.setNotificationHandler({
    // eslint-disable-next-line require-await -- expo-notifications requires async callback type but logic is synchronous
    handleNotification: async notification => {
      const data = notification.request.content.data as NotificationData | undefined;

      // Suppress only if the user is already viewing this exact chat
      if (data?.type === 'chat' && data.instanceId === activeChatInstanceId) {
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
    const data = response.notification.request.content.data as NotificationData | undefined;

    if (data?.type === 'chat') {
      const path = `/(app)/chat/${data.instanceId}`;
      // If the router is ready (has segments), navigate immediately.
      // Otherwise store as pending for consumption after auth completes.
      try {
        router.replace(path as Href);
      } catch {
        pendingNotificationLink = path;
      }
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
  const data = response.notification.request.content.data as NotificationData | undefined;
  if (data?.type === 'chat') {
    pendingNotificationLink = `/(app)/chat/${data.instanceId}`;
  }
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
  return Platform.OS as 'ios' | 'android';
}
