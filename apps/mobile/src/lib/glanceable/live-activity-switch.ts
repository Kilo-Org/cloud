/**
 * The in-app Live Activity switch and the notification permission, as values
 * the sinks can read synchronously.
 *
 * `use-live-activity-preference` owns the SecureStore round trip and pushes
 * every switch change here; `lib/notifications` pushes the permission. This
 * module holds only the current answers, and imports nothing, so the sink's
 * test graph stays free of React Native.
 */

/**
 * The switch either has an answer or has not been read yet. The union keeps
 * the two apart: a push-to-start subscription can reopen the surface remotely
 * and raise iOS's "Allow Live Activities?" prompt, so an unresolved preference
 * must never read as consent, while the sinks still treat it as the shipped
 * default of on.
 */
type LiveActivityPreference = { kind: 'unknown' } | { kind: 'known'; enabled: boolean };

let preference: LiveActivityPreference = { kind: 'unknown' };
/** Value listeners: told only when the resolved switch value changes. */
const listeners = new Set<() => void>();
/** Known listeners: told once when the switch leaves the unknown state. */
const knownListeners = new Set<() => void>();

/**
 * Starting a Live Activity raises iOS's own "Allow Live Activities?" prompt.
 * The surface waits for the user's notification opt-in, so that prompt never
 * appears before the user asked for notifications. Unknown until the first
 * read lands, which counts as not granted.
 */
let notificationsGranted = false;
const permissionListeners = new Set<() => void>();

/**
 * Defaults to on, which is what the app does before the disk read lands.
 * Surfaces read this, so an unread preference keeps their shipped behavior.
 */
export function getLiveActivityEnabled(): boolean {
  return preference.kind === 'known' ? preference.enabled : true;
}

/** Whether a stored switch value has been read, so the consent is real. */
export function isLiveActivityPreferenceKnown(): boolean {
  return preference.kind === 'known';
}

/**
 * The switch and the notification permission own the iOS push-to-start
 * subscription. While either is off, that token must never reach the server:
 * `endImmediate` clears the activity, but a live subscription would still let a
 * remote start reopen the surface, and a remote start raises the same prompt.
 * Only a preference that has been read can opt in, so the window before the
 * disk read lands refuses the token rather than trusting the default.
 */
export function canRegisterActivityTokenKind(kind: string): boolean {
  if (kind !== 'ios_push_to_start') {
    return true;
  }
  return preference.kind === 'known' && preference.enabled && notificationsGranted;
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

/**
 * Marks the preference known with `next`. Value listeners run only when the
 * resolved value changes, so a first read that resolves to on cannot end a
 * running activity: `getLiveActivityEnabled()` already answered on before it.
 * Known listeners run after the value listeners, once per unknown -> known
 * transition.
 */
export function setLiveActivityEnabledValue(next: boolean): void {
  const previous = getLiveActivityEnabled();
  const wasKnown = preference.kind === 'known';
  preference = { kind: 'known', enabled: next };
  if (previous !== next) {
    for (const listener of listeners) {
      listener();
    }
  }
  if (wasKnown) {
    return;
  }
  for (const listener of knownListeners) {
    listener();
  }
}

export function subscribeLiveActivityEnabled(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Told once when the preference leaves the unknown state. A token refused
 * while the disk read was pending retries on this signal, without waiting for
 * another native token event.
 */
export function subscribeLiveActivityPreferenceKnown(listener: () => void): () => void {
  knownListeners.add(listener);
  return () => {
    knownListeners.delete(listener);
  };
}

/** Test-only: restore the shipped defaults between cases. */
export function _resetLiveActivitySwitchForTests(): void {
  preference = { kind: 'unknown' };
  listeners.clear();
  knownListeners.clear();
  notificationsGranted = false;
  permissionListeners.clear();
}
