import { Platform } from 'react-native';

/**
 * Which surface confirms a destructive action.
 *
 * Android's native `AlertDialog` paints every button with the theme accent, so
 * `Alert.alert`'s `style: 'destructive'` never reaches the screen there and the
 * sign-out choice has no distinct affordance; Android therefore mounts the
 * in-app confirmation (the red `Button variant="destructive"`). iOS keeps the
 * native alert, which honors the style.
 *
 * The answer lives here, not in the screen that asks for it: the Profile screen
 * reads its side insets from `lib/screen-insets.ts`, and that alignment path is
 * held platform-free (`lib/screen-insets.test.ts`). A screen-level
 * `Platform.OS` branch — even one unrelated to the insets — breaks that check.
 */
export function needsInAppDestructiveConfirm(): boolean {
  return Platform.OS === 'android';
}
