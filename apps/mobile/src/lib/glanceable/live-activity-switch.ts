/**
 * The in-app Live Activity switch and the notification permission, as values
 * the sinks can read synchronously.
 *
 * `use-live-activity-preference` owns the SecureStore round trip and pushes
 * every switch change here; `lib/notifications` pushes the permission. This
 * module holds only the current answers, and imports nothing, so the sink's
 * test graph stays free of React Native.
 */

let enabled = true;
const listeners = new Set<() => void>();

/**
 * Starting a Live Activity raises iOS's own "Allow Live Activities?" prompt.
 * The surface waits for the user's notification opt-in, so that prompt never
 * appears before the user asked for notifications. Unknown until the first
 * read lands, which counts as not granted.
 */
let notificationsGranted = false;
const permissionListeners = new Set<() => void>();

/** Defaults to on, which is what the app does before the disk read lands. */
export function getLiveActivityEnabled(): boolean {
  return enabled;
}

/**
 * The switch and the notification permission own the iOS push-to-start
 * subscription. While either is off, that token must never reach the server:
 * `endImmediate` clears the activity, but a live subscription would still let a
 * remote start reopen the surface, and a remote start raises the same prompt.
 */
export function canRegisterActivityTokenKind(kind: string): boolean {
  return kind !== 'ios_push_to_start' || (enabled && notificationsGranted);
}

export function getNotificationPermissionGranted(): boolean {
  return notificationsGranted;
}

export function setNotificationPermissionGrantedValue(next: boolean): void {
  if (next === notificationsGranted) {
    return;
  }
  notificationsGranted = next;
  for (const listener of permissionListeners) {
    listener();
  }
}

export function subscribeNotificationPermissionGranted(listener: () => void): () => void {
  permissionListeners.add(listener);
  return () => {
    permissionListeners.delete(listener);
  };
}

export function setLiveActivityEnabledValue(next: boolean): void {
  if (next === enabled) {
    return;
  }
  enabled = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeLiveActivityEnabled(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: restore the shipped defaults between cases. */
export function _resetLiveActivitySwitchForTests(): void {
  enabled = true;
  listeners.clear();
  notificationsGranted = false;
  permissionListeners.clear();
}
