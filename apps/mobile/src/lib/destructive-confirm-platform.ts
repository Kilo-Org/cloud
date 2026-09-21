import { Platform } from 'react-native';

/**
 * Android's native `AlertDialog` paints every button with the theme accent, so
 * `Alert.alert`'s `style: 'destructive'` never reaches the screen there: Android
 * opens the in-app `DestructiveConfirmDialog` instead. iOS honors the native
 * destructive style and keeps `Alert.alert`.
 *
 * The choice lives here so `profile-screen.tsx` carries no platform fork: that
 * screen reads its side insets through `@/lib/screen-insets`, and
 * `screen-insets.test.ts` holds that shared path to one cross-platform
 * implementation.
 */
export function usesInAppDestructiveConfirm(): boolean {
  return Platform.OS === 'android';
}
