import { type ReactNode, useEffect } from 'react';
import { View } from 'react-native';

import { isTabSwitchPending, settleTabSwitchInput } from '@/lib/tab-switch-input-gate';

/** The scene surface the gate reads: this scene's own focus events. */
type SceneNavigation = {
  addListener: (event: 'focus', listener: () => void) => () => void;
};

/**
 * Closes the input window when this scene reports focus — the moment it is the
 * scene the next touch is hit-tested against.
 *
 * A component of its own because the navigator calls a `screenLayout` as a
 * plain function: hooks there join the navigator's own hook order and change it
 * between renders. This one renders nothing.
 */
function SceneFocusSettle({ navigation }: Readonly<{ navigation: SceneNavigation }>) {
  useEffect(() => navigation.addListener('focus', settleTabSwitchInput), [navigation]);
  return null;
}

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
 * The window is closed by the tab stacks' `transitionEnd` listener
 * (`settleTabSwitchInput`, passed by the tab layouts), by this scene's own
 * `focus`, and, for a press that opens no screen, by the bounded settle in
 * `tab-switch-input-gate.ts`. The focus settle is what a tab switch needs: it
 * pushes nothing into the destination stack, so no `transitionEnd` fires there,
 * and the window used to run to its bound. Every touch inside the newly shown
 * tab screen — the Agents empty state's view-history link, or any other control
 * — was dropped silently for that whole window (explorer finding: the link did
 * nothing).
 */
export function TabSwitchInputSettle({
  navigation,
  children,
}: Readonly<{ navigation: SceneNavigation; children?: ReactNode }>) {
  return (
    <View
      className="flex-1"
      onStartShouldSetResponderCapture={() => isTabSwitchPending()}
      onResponderTerminationRequest={() => false}
    >
      <SceneFocusSettle navigation={navigation} />
      {children}
    </View>
  );
}
