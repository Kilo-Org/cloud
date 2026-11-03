import { type ReactNode } from 'react';
import { View } from 'react-native';

import { shouldClaimTabSwitchTouch } from '@/lib/tab-switch-input-gate';

/** The scene surface the gate reads: whether this scene is the focused one. */
type SceneNavigation = { isFocused: () => boolean };

/**
 * The tabs navigator's `screenLayout`: every tab screen is wrapped by it, and
 * the tab bar is not, because the navigator renders the bar beside the scenes
 * rather than inside one.
 *
 * `onStartShouldSetResponderCapture` claims a touch that starts while a pressed
 * tab is still settling, so the tab being left cannot act on a tap aimed at the
 * incoming one (explorer finding: the Profile Code Reviewer row's tap reached
 * the Home new-task button). The window is read when the touch arrives, not
 * when this renders: it opens inside the tab entry's press, and a prop could
 * only follow the commit whose absence is the problem.
 *
 * The claim belongs below the bar and not on a wrapper around the navigator: a
 * bar press during the window is a new tab choice — the last tab tapped must
 * win — and it has to reach the entry to navigate at all. It belongs here, on
 * the navigator, rather than in each tab stack's layout: a stack layout is what
 * a tab family renders, so only the families that remembered to mount it were
 * shielded.
 *
 * Which scene claims is decided by that scene's own focus: the scene the user
 * is leaving is the one the touch was hit-tested against, and it reports itself
 * blurred from the moment the destination is chosen, while the destination
 * reports itself focused before its views have replaced the old ones. Claiming
 * on "the scene I am not on" therefore shields exactly the outgoing screen for
 * exactly as long as it stays in the touch path, and never blocks the screen
 * the user switched to. Closing the window from a navigation event could not do
 * that: measured on the Android emulator, the destination's `focus` fires
 * before the scenes swap and even its `transitionEnd` can land while the
 * outgoing views are still the touch targets, so a window settled from either
 * one let a tap run the outgoing screen's control. Without the focus-scoped
 * claim, nothing settled the window on a tab switch at all — it pushes nothing
 * into the destination stack — and every touch inside the newly shown tab
 * screen, the Agents empty state's view-history link included, was dropped
 * silently until the window's 1200 ms bound expired (explorer finding: the link
 * did nothing).
 */
export function TabSwitchInputSettle({
  navigation,
  children,
}: Readonly<{ navigation: SceneNavigation; children?: ReactNode }>) {
  return (
    <View
      className="flex-1"
      onStartShouldSetResponderCapture={() => shouldClaimTabSwitchTouch(navigation.isFocused())}
      onResponderTerminationRequest={() => false}
    >
      {children}
    </View>
  );
}
