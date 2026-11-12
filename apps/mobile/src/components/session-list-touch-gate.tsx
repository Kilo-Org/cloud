import { type ReactNode } from 'react';
import { View } from 'react-native';

import { isSessionListTouchHeld } from '@/lib/session-list-touch-gate';

/**
 * Wraps a session list's body and claims a touch that starts while a Clear
 * action is still swapping that body.
 *
 * The clear runs on press release and the rows mount in the same commit, so the
 * row that appears under the finger is a new target by the time a repeat tap
 * arrives; without this gate that tap opens the row. The claim reads the hold
 * when the touch arrives, not when this renders, and is answered with nothing —
 * the same shape as `SheetTouchGuard` and `TabSwitchInputSettle`. The hold is
 * bounded (`SESSION_LIST_TOUCH_SETTLE_MS`) because the list's own rows live in
 * this tree and must get their presses back.
 */
export function SessionListTouchGate({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <View
      className="flex-1"
      onStartShouldSetResponderCapture={() => isSessionListTouchHeld()}
      onResponderTerminationRequest={() => false}
    >
      {children}
    </View>
  );
}
