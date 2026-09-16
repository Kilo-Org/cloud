import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

/**
 * The native surface `modules/notification-focus-filter` exposes. The Swift
 * module reads the choice the `AgentProgressFocusFilter` persisted for the
 * active Focus.
 */
type NotificationFocusFilterNativeModule = {
  isAgentProgressAllowed(): boolean;
};

/**
 * Whether the active iOS Focus allows agent-progress notifications.
 *
 * Android has no Focus filters — its per-kind choice is the notification
 * channel, which the system settings own — so this is always `true` there and
 * the native module is never required. On iOS a missing module (an old build
 * without the rebuilt native code) or a throwing read also falls back to
 * `true`: an absent answer must never suppress a notification the user did not
 * exclude. The read is never cached, so switching Focus takes effect on the
 * next push.
 */
export function isAgentProgressAllowedInActiveFocus(): boolean {
  if (Platform.OS !== 'ios') {
    return true;
  }
  try {
    const native =
      requireNativeModule<NotificationFocusFilterNativeModule>('NotificationFocusFilter');
    return native.isAgentProgressAllowed();
  } catch {
    // A missing module or a failed native read must never suppress a notification.
    return true;
  }
}
