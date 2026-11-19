import { requireOptionalNativeModule } from 'expo';

/**
 * The function `patches/expo-notifications@*.patch` adds to the iOS emitter
 * module. Android and an iOS build without the patch do not have it.
 */
type NotificationsEmitterNativeModule = {
  finishHandlingNotificationResponse?: (key: string) => void;
};

/**
 * Tell iOS that the app finished handling a notification response.
 *
 * iOS keeps the app running for an Approve or Reply tap only until the response
 * is finished, so the patched module holds the response until this call (or
 * until its own timeout). `key` is the response's request identifier and action
 * identifier, joined by `:`. Elsewhere this does nothing.
 */
export function finishHandlingNotificationResponse(key: string): void {
  try {
    requireOptionalNativeModule<NotificationsEmitterNativeModule>(
      'ExpoNotificationsEmitter'
    )?.finishHandlingNotificationResponse?.(key);
  } catch {
    // The native timeout still finishes the response.
  }
}
