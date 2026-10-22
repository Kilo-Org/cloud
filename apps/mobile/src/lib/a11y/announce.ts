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
 * Ask the platform to move assistive-technology focus to a component by ref.
 * The boolean reports only what this function can observe:
 *
 * - `true`: a focusable node handle was found and the focus request was
 *   dispatched.
 * - `false`: the ref had no mounted node, or the native call threw (swallowed,
 *   never propagated).
 *
 * `true` is not proof that focus moved. React Native's `setAccessibilityFocus`
 * reports no outcome, so a platform that honours the request and one that
 * ignores it look identical here; a caller must not skip a fallback focus
 * target because the request was dispatched. The useful signal is `false`:
 * the node did not exist yet, so a later signal (mount, layout, next frame)
 * can retry the request.
 */
export function requestA11yFocus(ref: RefObject<Component | null>): boolean {
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
