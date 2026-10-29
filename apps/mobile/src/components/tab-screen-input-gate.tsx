import { type ReactNode } from 'react';
import { View } from 'react-native';

import { isTabSwitchPending } from '@/lib/tab-switch-input-gate';

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
 * (`settleTabSwitchInput`, passed by the tab layouts) and, for a press that
 * opens no screen, by the bounded settle in `tab-switch-input-gate.ts`.
 */
export function TabSwitchInputSettle({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <View
      className="flex-1"
      onStartShouldSetResponderCapture={() => isTabSwitchPending()}
      onResponderTerminationRequest={() => false}
    >
      {children}
    </View>
  );
}
