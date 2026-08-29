import { AccessibilityInfo, findNodeHandle } from 'react-native';
import { type Component, type RefObject } from 'react';

import { announceLocalAccessPrivacy } from '@/lib/local-access-privacy';

// Shared accessibility helpers keep native delivery and focus handling in one
// place. Native privacy checks protected speech again after queueing; denied
// announcements are never replayed. Accessibility failures must not break UI
// completion flows.

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
    void announceLocalAccessPrivacy(trimmed);
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
