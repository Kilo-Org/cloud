import { type ReactNode } from 'react';
import { View } from 'react-native';

import { useAppAwareKeyboardPadding } from '@/components/kilo-chat/app-aware-keyboard-padding';
import { useTabBarBottomPadding } from '@/components/tab-screen';

/**
 * Pinned primary action for the manual-review form.
 *
 * The action used to be the scroll body's last child. At large display
 * densities the form is taller than the viewport, so it was clipped mid-label
 * at the scroll fold, against the tab bar (explorer manual-review finding,
 * 2026-09-19). The footer keeps its own layout space clear of the tab bar, so
 * the call to action is always fully legible.
 *
 * The host wraps this footer and the scroll body in the keyboard-lift view,
 * which owns the bottom space while the keyboard is open. The footer's own
 * clearance therefore covers only what the lift does not: a keyboard taller
 * than the tab bar drops it to 0, while a keyboard shorter than the tab bar
 * (the hardware-keyboard IME bar is one navigation bar tall) keeps the rest, so
 * the action never lands behind the tab bar (e1-fill, 2026-09-19).
 */
export function ManualReviewActionFooter({ children }: Readonly<{ children: ReactNode }>) {
  const tabBarBottomPadding = useTabBarBottomPadding();
  const keyboardLift = useAppAwareKeyboardPadding();
  const bottomPadding = Math.max(0, tabBarBottomPadding - keyboardLift);
  return (
    <View className="bg-background px-6 pt-3" style={{ paddingBottom: bottomPadding }}>
      {children}
    </View>
  );
}
