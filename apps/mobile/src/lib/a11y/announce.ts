import { AccessibilityInfo, findNodeHandle } from 'react-native';
import { type Component, type RefObject } from 'react';

// Shared accessibility helpers used across mobile screens. These wrap
// `react-native` primitives so call sites stay small and so unit tests can
// target a single import surface (rather than mocking `react-native`
// per-feature). The functions are intentionally side-effecting and best
// effort — they never throw on missing handles or native accessibility
// failures, so a TalkBack/VoiceOver outage never breaks the UI or a caller's
// completion flow.

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
 * Move assistive-technology focus to a component by ref. Returns `true` if a
 * focusable node handle was found and the platform accepted the move, so
 * callers can fall back to a different focus target on tablets/web where
 * `setAccessibilityFocus` may be a no-op. A throwing native call counts as a
 * rejected move (returns `false`) and never propagates.
 */
export function moveA11yFocus(ref: RefObject<Component | null>): boolean {
  const node = findNodeHandle(ref.current);
  if (node == null) {
    return false;
  }
  try {
    AccessibilityInfo.setAccessibilityFocus(node);
  } catch {
    return false;
  }
  return true;
}
