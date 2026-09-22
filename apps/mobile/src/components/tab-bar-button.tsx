import { Pressable } from 'react-native';
import { type BottomTabBarButtonProps } from 'expo-router/js-tabs';

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
 */
export function TabBarButton({
  ref: _ref,
  href: _href,
  pressColor: _pressColor,
  pressOpacity: _pressOpacity,
  hoverEffect: _hoverEffect,
  ...props
}: BottomTabBarButtonProps) {
  return <Pressable {...props} accessible role="button" />;
}
