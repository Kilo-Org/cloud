import { requireOptionalNativeModule } from 'expo';

/**
 * The native surface `modules/notification-focus-filter` exposes. The Swift
 * module reads the choice the `AgentProgressFocusFilter` persisted for the
 * active Focus.
 */
type NotificationFocusFilterNativeModule = {
  isAgentProgressAllowed(): boolean;
};

/**
 * Whether the active Focus allows agent-progress notifications.
 *
 * Registering `NotificationFocusFilter` is an iOS-only capability: Android has
 * no Focus filter — its per-kind choice is the notification channel, which the
 * system settings own — so the module is absent there. The read is therefore the
 * same code on both platforms: the optional module lookup returns `null` on
 * Android and on an old iOS build without the rebuilt native code, and a
 * throwing read is caught below. Both fall back to `true`, because an absent
 * answer must never suppress a notification the user did not exclude. The read
 * is never cached, so switching Focus takes effect on the next push.
 */
export function isAgentProgressAllowedInActiveFocus(): boolean {
  try {
    const native =
      requireOptionalNativeModule<NotificationFocusFilterNativeModule>('NotificationFocusFilter');
    if (!native) {
      return true;
    }
    return native.isAgentProgressAllowed();
  } catch {
    // A missing module or a failed native read must never suppress a notification.
    return true;
  }
}
