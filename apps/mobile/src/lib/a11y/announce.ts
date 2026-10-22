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
 * Move assistive-technology focus to a mounted native host. A missing host or
 * throwing native call returns false so the caller can choose another target.
 */
export function moveA11yFocus(ref: RefObject<HostInstance | null>): boolean {
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
