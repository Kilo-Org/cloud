import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTabBarBottomPadding } from '@/components/tab-screen';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { cn } from '@/lib/utils';

/** The band a footer keeps under its content on a device without a home indicator. */
const FOOTER_FLOOR = 16;

type ScreenFooterProps = {
  children: ReactNode;
  /**
   * The space the footer reserves under its content:
   * - `safe-area` (default): the window's bottom inset, floored at 16pt;
   * - `tab-bar`: the tab bar's rendered band and its trailing gap, for a footer
   *   pinned above the bar;
   * - `host`: none — the host already reserves that band (a sheet's own inset,
   *   or a scroll view's content inset).
   */
  clearance?: 'safe-area' | 'tab-bar' | 'host';
  /**
   * Who keeps the footer clear of the keyboard. `footer` (default) shrinks its
   * own band by the keyboard it is under, so the action stays reachable;
   * `host` leaves the lift to `@/components/keyboard-lift-view` or a scroll
   * view's `automaticallyAdjustKeyboardInsets`, which would double-count it.
   */
  keyboard?: 'footer' | 'host';
  /**
   * `hairline` (default) draws the 0.5pt divider that separates the bar from the
   * content it pins above; `background` paints the page background alone, for a
   * footer that follows a visible edge of its own.
   */
  edge?: 'hairline' | 'background';
  /** Extra classes on the bar itself, outside the gutter and the reserved band. */
  className?: string;
};

/**
 * The one pinned primary-action bar: page gutter, optional hairline, and the
 * bottom band the platform needs, with the keyboard rule the app's keyboard
 * contract asks for.
 *
 * A screen has one primary action, so it has one footer (`apps/mobile/AGENTS.md`,
 * "Primary action"). The caller keeps the scroll body above it; the footer owns
 * the bottom edge, so the body does not add its own end padding.
 */
export function ScreenFooter({
  children,
  clearance = 'safe-area',
  keyboard = 'footer',
  edge = 'hairline',
  className,
}: Readonly<ScreenFooterProps>) {
  const { bottom } = useSafeAreaInsets();
  const tabBarBand = useTabBarBottomPadding();
  const keyboardHeight = useKeyboardState(state => state.height);
  const sideInsetStyle = useSideInsetStyle();

  let reserved = 0;
  if (clearance === 'safe-area') {
    reserved = Math.max(bottom, FOOTER_FLOOR);
  } else if (clearance === 'tab-bar') {
    reserved = tabBarBand;
  }
  const paddingBottom = keyboard === 'footer' ? Math.max(0, reserved - keyboardHeight) : reserved;

  return (
    <View
      className={cn(
        'bg-background',
        edge === 'hairline' && 'border-t-[0.5px] border-hair-soft',
        className
      )}
      style={{ paddingBottom, ...sideInsetStyle }}
    >
      <View className="px-4 pt-3">{children}</View>
    </View>
  );
}
