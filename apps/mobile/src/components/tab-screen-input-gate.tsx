import { type ReactNode } from 'react';
import { View } from 'react-native';

import { isTabSwitchPending } from '@/lib/tab-switch-input-gate';

/**
 * A tab screen's own layout root, and the surface that reads the tab-switch
 * window. `onStartShouldSetResponderCapture` claims a touch that starts while a
 * pressed tab is still settling, so the tab being left cannot act on a tap
 * aimed at the incoming one (explorer finding: the Profile Code Reviewer row's
 * tap reached the Home new-task button). The window is read when the touch
 * arrives, not when this renders: it opens inside the tab entry's press, and a
 * prop could only follow the commit whose absence is the problem.
 *
 * The claim belongs here, on each tab's own content, and not on a wrapper
 * around the navigator: the tab bar is a sibling of the tab screens, so a
 * wrapper that spans both would also claim the bar's own touches. A bar press
 * during the window is a new tab choice — the last tab tapped must win — and it
 * has to reach the entry to navigate at all.
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
