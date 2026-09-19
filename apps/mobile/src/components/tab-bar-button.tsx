import { type ComponentProps, type ReactNode } from 'react';
import { type ColorValue, Pressable } from 'react-native';

/**
 * The props expo-router's bottom tab item hands the `tabBarButton` renderer:
 * `Pressable`'s props plus the navigation-only keys below, which a plain
 * `Pressable` does not understand. Declared from the `Pressable` this button
 * wraps instead of imported from `expo-router`, so the tab bar has one
 * implementation on both platforms and pulls in no extra module.
 */
export type TabBarButtonProps = Omit<ComponentProps<typeof Pressable>, 'ref'> & {
  children?: ReactNode;
  href?: string;
  hoverEffect?: unknown;
  pressColor?: ColorValue;
  pressOpacity?: number;
  ref?: unknown;
};

/**
 * The bottom tab bar's pressable, identical on iOS and Android.
 *
 * expo-router's default tab button forks itself: it gives the tab the role
 * `button` on iOS and `tab` on Android. React Native has no mapping for `tab`
 * on Android (`ReactAccessibilityDelegate.AccessibilityRole.getValue`), so it
 * renders the tab as `android.view.View` — a plain view where the app meant a
 * control. Pinning the role to `button` here, the role iOS already had, makes
 * both platforms render the tab as a control (`android.widget.Button` on
 * Android) with one implementation. The `tabBarAccessibilityLabel` still
 * carries the tab wording and position ("Home, tab, 1 of 3"), so a screen
 * reader keeps the tab meaning.
 *
 * Everything else the default button carries is passed through: the layout
 * style, the Android ripple, `aria-selected`, the test id, `onPress`/`onLongPress`
 * and the iOS large content viewer. Only the props this `Pressable` cannot use
 * are dropped — `ref` (expo-router passes none), `href` (web-only),
 * `pressColor`, `pressOpacity` (always 1 for this bar, so it animates nothing)
 * and `hoverEffect` (set only by the sidebar/material variants). The phone tab
 * bar therefore loses no press feedback.
 */
export function TabBarButton({
  href: _href,
  hoverEffect: _hoverEffect,
  pressColor: _pressColor,
  pressOpacity: _pressOpacity,
  ref: _ref,
  ...props
}: TabBarButtonProps) {
  return <Pressable {...props} role="button" />;
}
