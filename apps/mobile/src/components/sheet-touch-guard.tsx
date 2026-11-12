import { type ReactNode } from 'react';
import { View } from 'react-native';

import { isSheetTouchHeld } from '@/lib/sheet-touch-guard';

/**
 * Wraps what a native sheet covers, and claims a touch that starts before the
 * sheet's own window takes touch.
 *
 * It claims in the capture phase, above every descendant it wraps — the screen
 * and the tab bar included — and reads the hold when the touch arrives, not when
 * it renders: a layer that has to be mounted first is in the touch path after
 * the touch it should have claimed (measured on the Android emulator: a tap
 * ~90 ms after the sheet was requested still reached the tab bar). The same
 * shape the tab-switch settle uses for its window (`TabSwitchInputSettle`).
 *
 * A claimed touch is answered with nothing, so the screen and the tab bar behind
 * a still-opening sheet cannot act: pressing its Cancel afterwards returns the
 * user to the place they opened it from. The hold is bounded to the handover
 * (`SHEET_TOUCH_HOLD_MS`), because the sheet's own content is part of this tree
 * and must get its presses back once the sheet is up; the sheet re-arms the
 * same bounded hold for its dismissal, so a tap during the close animation is
 * kept from the row behind it in the same way.
 */
export function SheetTouchGuard({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <View
      className="flex-1"
      onStartShouldSetResponderCapture={() => isSheetTouchHeld()}
      onResponderTerminationRequest={() => false}
    >
      {children}
    </View>
  );
}
