import { useRef } from 'react';
import { Pressable, type ViewStyle } from 'react-native';
import { type BottomTabBarButtonProps } from 'expo-router/js-tabs';

import { markTabSwitchPending, scheduleTabSwitchSettle } from '@/lib/tab-switch-input-gate';

// `PlatformPressable` cursors the entry on an iOS pointer device, and React
// Native's `Pressable` sets no cursor at all, so the iPadOS pointing hand would
// be lost without this (review finding on this file). `cursor` is one style
// value for both platforms: iOS applies the pointing hand and Android has no
// cursor capability to apply it to, so the single value is inert there. The
// bar's own style is merged after it.
const POINTER_CURSOR_STYLE = {
  cursor: 'pointer',
} satisfies ViewStyle;

/**
 * One bottom-tab entry, as the OS sees it. Android types a control by its
 * native class, and expo-router renders the entry with `role="tab"`, which
 * React Native maps to a bare `android.view.View` (explorer finding 10:
 * "controls the OS cannot type"). The same pressable with the button role keeps
 * the ripple, the press behaviour and the `Home, tab, 1 of 3` label, and gives
 * Android the `android.widget.Button` class the entry already carries on iOS,
 * where the library uses the button role.
 *
 * The dropped props belong to expo-router's `PlatformPressable`, not to this
 * entry: a link `href`, a press colour, a press opacity of 1 and a hover
 * overlay that renders nothing on native. React Native's own `Pressable`
 * renders the entry from the rest -- the bar's own `android_ripple` included --
 * and, unlike that module, it does not drag the header's PNG assets into a
 * mounted test's import graph.
 *
 * A press in arms the tab-switch input gate: until the destination screen is on
 * screen, the outgoing tab is still what a touch is hit-tested against, so the
 * next tap would run a control of the tab being left. Arming on the touch down
 * covers the whole gesture, including a tap that lands before the navigation
 * has rendered. A gesture that ends without its press (dragged off the entry)
 * settled in, so it closes the gate on the next tick instead of holding it.
 */
export function TabBarButton({
  ref: _ref,
  href: _href,
  pressColor: _pressColor,
  pressOpacity: _pressOpacity,
  hoverEffect: _hoverEffect,
  onPress,
  onPressIn,
  onPressOut,
  style,
  ...props
}: BottomTabBarButtonProps) {
  const pressed = useRef(false);
  return (
    <Pressable
      {...props}
      onPressIn={event => {
        pressed.current = true;
        markTabSwitchPending();
        onPressIn?.(event);
      }}
      onPress={event => {
        pressed.current = false;
        // A completed press navigates, so its window starts here: this clears a
        // settle the touch up may already have scheduled.
        markTabSwitchPending();
        onPress?.(event);
      }}
      onPressOut={event => {
        if (pressed.current) {
          // `onPressOut` runs before `onPress`, so the press still gets this
          // tick to keep the window open; only a cancelled press settles here.
          scheduleTabSwitchSettle(0);
        }
        onPressOut?.(event);
      }}
      accessible
      role="button"
      style={[POINTER_CURSOR_STYLE, style]}
    />
  );
}
