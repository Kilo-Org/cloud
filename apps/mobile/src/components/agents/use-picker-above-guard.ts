import { useNavigation, usePreventRemove, useRouter } from 'expo-router';
import { useState } from 'react';

import { isLeaveAction } from '@/lib/navigation/leave-actions';
import { pickerRouteOnTop } from '@/lib/picker-routes';

/**
 * Keeps a Back that arrives while one of this screen's pickers is opening with
 * that picker.
 *
 * A picker is a native `formSheet` presented over the screen that opened it.
 * During the opening presentation the native stack still has that screen on
 * top, so a hardware Back in that window removes the screen instead of the
 * picker, and a JavaScript BackHandler listener never sees the press. The
 * removal is refused instead, and the picker route is popped — the same path
 * its own Done control uses. The screen and its state stay.
 *
 * The removal is refused for every Back, not only while a picker looks open:
 * the screen under a sheet has not re-rendered yet when the Back lands, so the
 * picker is read from the live navigation state at that moment. Every other
 * Back is replayed unchanged; non-leave removals are replayed too.
 */
export function usePickerAboveLeaveGuard(): void {
  const navigation = useNavigation();
  const router = useRouter();
  // One-shot: a removal that must go through, replayed below.
  const [leaveAllowed, setLeaveAllowed] = useState(false);

  usePreventRemove(!leaveAllowed, ({ data, repeat }) => {
    const leave = () => {
      setLeaveAllowed(true);
      repeat();
    };
    if (isLeaveAction(data.action.type) && pickerRouteOnTop(navigation.getState())) {
      router.back();
      return;
    }
    leave();
  });
}
