import { type ReactNode } from 'react';
import { View } from 'react-native';

import { isTabSwitchPending, settleTabSwitchInput } from '@/lib/tab-switch-input-gate';

/**
 * The tab surface. `onStartShouldSetResponderCapture` claims a touch that starts
 * while a pressed tab is still settling, so the tab being left cannot act on a
 * tap aimed at the incoming one (explorer finding: the Profile Code Reviewer
 * row's tap reached the Home new-task button). The window is read when the touch
 * arrives, not when this renders: it opens inside the tab entry's press, and a
 * prop could only follow the commit whose absence is the problem.
 */
export function TabSwitchInputGate({ children }: Readonly<{ children: ReactNode }>) {
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

/**
 * A tab screen's own layout root. Its next layout is the moment that tab is on
 * screen, which is when the window can close: the route state changes earlier,
 * while the outgoing tab's views are still what a touch is hit-tested against.
 */
export function TabSwitchInputSettle({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <View className="flex-1" onLayout={settleTabSwitchInput}>
      {children}
    </View>
  );
}
