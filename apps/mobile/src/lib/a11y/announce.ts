import { AccessibilityInfo, findNodeHandle } from 'react-native';
import { type Component, type RefObject } from 'react';

// Shared accessibility helpers used across mobile screens. These wrap
// `react-native` primitives so call sites stay small and so unit tests can
// target a single import surface (rather than mocking `react-native`
// per-feature). The functions are intentionally side-effecting — they do not
// throw on missing handles or unsupported platforms, so a TalkBack/VoiceOver
// outage never breaks the UI.

/**
 * Announce a message to assistive technologies (TalkBack on Android,
 * VoiceOver on iOS). Empty or whitespace-only messages are dropped so a
 * stray re-render can't silence a still-pending notification.
 */
export function announceForA11y(message: string): void {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }
  AccessibilityInfo.announceForAccessibility(trimmed);
}

/**
 * Move assistive-technology focus to a component by ref. Returns `true` if a
 * focusable node handle was found and the platform accepted the move, so
 * callers can fall back to a different focus target on tablets/web where
 * `setAccessibilityFocus` may be a no-op.
 */
export function moveA11yFocus(ref: RefObject<Component | null>): boolean {
  const node = findNodeHandle(ref.current);
  if (node == null) {
    return false;
  }
  AccessibilityInfo.setAccessibilityFocus(node);
  return true;
}
