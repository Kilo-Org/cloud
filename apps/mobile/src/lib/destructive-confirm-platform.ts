import { Platform } from 'react-native';

/**
 * Whether a destructive confirmation needs the in-app `DestructiveConfirmDialog`
 * instead of `Alert.alert`.
 *
 * Android's native dialog paints every button with the theme accent, so
 * `style: 'destructive'` never reaches the screen there and the destructive
 * choice has no distinct affordance; the in-app dialog carries the red variant.
 * iOS honors `style: 'destructive'` and keeps the native alert.
 *
 * The platform read lives in this module rather than in the screen because
 * `src/lib/screen-insets.test.ts` holds the Profile screen to one
 * platform-agnostic implementation (the same shape as
 * `src/lib/pr-review/connect-gate-platform.ts`).
 */
export function needsInAppDestructiveConfirm(): boolean {
  return Platform.OS === 'android';
}
