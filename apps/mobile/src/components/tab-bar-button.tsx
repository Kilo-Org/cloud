import { type BottomTabBarButtonProps } from 'expo-router/js-tabs';
import { Pressable } from 'react-native';

type TabBarButtonProps = Omit<BottomTabBarButtonProps, 'children'> & {
  /** The icon and label cells expo-router renders inside the button. */
  children?: React.ReactNode;
};

/**
 * The bottom tab bar's pressable.
 *
 * expo-router's default tab button hands an Android tab item the ARIA role
 * `tab`, and React Native renders that role as `android.view.View`
 * (`ReactAccessibilityDelegate.AccessibilityRole.getValue`): the OS and a
 * screen reader meet a plain view where the app meant a control. Here the role
 * is pinned to `button` — the role expo-router itself uses for these items on
 * iOS — which React Native renders as `android.widget.Button`. The
 * `tabBarAccessibilityLabel` still carries the tab wording and position
 * ("Home, tab, 1 of 3"), so the screen reader keeps the tab meaning.
 *
 * Everything else the default button carries is passed through: the layout
 * style, the Android ripple, `aria-selected`, the test id, `onPress`/`onLongPress`
 * and the iOS large content viewer. Only the props a plain `Pressable` does not
 * understand are dropped — `ref` (expo-router passes none), `href` (web-only),
 * `pressColor`, `pressOpacity` (always 1 for this bar, so it animates nothing)
 * and `hoverEffect` (set only by the sidebar/material variants). The phone tab
 * bar therefore loses no press feedback.
 */
export function TabBarButton({
  android_ripple,
  href: _href,
  hoverEffect: _hoverEffect,
  pressColor: _pressColor,
  pressOpacity: _pressOpacity,
  ref: _ref,
  ...props
}: TabBarButtonProps) {
  return <Pressable {...props} android_ripple={android_ripple} role="button" />;
}
