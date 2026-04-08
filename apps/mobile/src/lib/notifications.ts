import expoConstants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { type Href, router } from 'expo-router';
import { Platform } from 'react-native';
import { toast } from 'sonner-native';

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
type NotificationData = { type: 'chat'; instanceId: string };

export function setupNotificationHandler() {
  Notifications.setNotificationHandler({
    // eslint-disable-next-line require-await -- expo-notifications requires async callback type but logic is synchronous
    handleNotification: async notification => {
      const data = notification.request.content.data as NotificationData | undefined;

      const suppressed = {
        shouldShowAlert: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      } as const;

      if (data?.type === 'chat') {
        // If the user is viewing the exact chat this notification is for, suppress it
        if (data.instanceId === activeChatInstanceId) {
          return suppressed;
        }

        // User is in the app but not in this chat — show in-app banner via toast
        // and suppress the system notification
        const title = notification.request.content.title ?? 'Kilo';
        const body = notification.request.content.body ?? '';
        toast(title, {
          description: body,
          action: {
            label: 'View',
            onClick: () => {
              router.push(`/(app)/chat/${data.instanceId}` as Href);
            },
          },
        });
        return suppressed;
      }

      // Non-chat notification — show normally
      return {
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      };
    },
  });
}

export function setupNotificationResponseHandler() {
  const subscription = Notifications.addNotificationResponseReceivedListener(response => {
    const data = response.notification.request.content.data as NotificationData | undefined;

    if (data?.type === 'chat') {
      router.push(`/(app)/chat/${data.instanceId}` as Href);
    }
  });

  return subscription;
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
