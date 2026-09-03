/**
 * The in-app Live Activity switch, as a value the sink can read.
 *
 * `use-live-activity-preference` owns the SecureStore round trip and pushes
 * every change here. This module holds only the current answer, and imports
 * nothing, so the sink's test graph stays free of React Native.
 */

let enabled = true;
const listeners = new Set<() => void>();

/** Defaults to on, which is what the app does before the disk read lands. */
export function getLiveActivityEnabled(): boolean {
  return enabled;
}

/**
 * The switch owns the iOS push-to-start subscription. While it is off, that
 * token must never reach the server: `endImmediate` clears the activity, but a
 * live subscription would still let a remote start reopen the surface.
 */
export function canRegisterActivityTokenKind(kind: string): boolean {
  return kind !== 'ios_push_to_start' || enabled;
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

/** Test-only: restore the shipped default between cases. */
export function _resetLiveActivitySwitchForTests(): void {
  enabled = true;
  listeners.clear();
}
