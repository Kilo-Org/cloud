import { AccessibilityInfo, type HostInstance } from 'react-native';
import { type RefObject } from 'react';

/**
 * Announce a message to assistive technologies (TalkBack on Android,
 * VoiceOver on iOS). Empty or whitespace-only messages are dropped so a
 * stray re-render can't silence a still-pending notification. A native
 * announcement failure is swallowed: the visual UI and the caller's flow must
 * continue even when the platform accessibility layer is unavailable.
 */
export function announceForA11y(message: string): void {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }
  try {
    AccessibilityInfo.announceForAccessibility(trimmed);
  } catch {
    // Best effort: a native accessibility outage must never break the UI.
  }
}

/**
 * Request assistive-technology focus on a mounted native host.
 * `true` means the host existed and the request was dispatched without throwing,
 * not that focus moved: `sendAccessibilityEvent` reports no outcome.
 * `false` means the host was missing or the native call threw (swallowed), so a
 * caller can retry when the host mounts or choose another target.
 */
export function requestA11yFocus(ref: RefObject<HostInstance | null>): boolean {
  const node = ref.current;
  if (node == null) {
    return false;
  }
  try {
    AccessibilityInfo.sendAccessibilityEvent(node, 'focus');
  } catch {
    return false;
  }
  return true;
}
