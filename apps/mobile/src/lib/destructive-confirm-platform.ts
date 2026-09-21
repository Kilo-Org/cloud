import { Platform } from 'react-native';

/**
 * Whether a destructive confirmation must render as the in-app
 * `DestructiveConfirmDialog` instead of the native `Alert.alert`.
 *
 * Android's native `AlertDialog` paints every button with the theme accent, so
 * `Alert.alert`'s `style: 'destructive'` never reaches the screen there; iOS
 * honors it. The caller asks this helper rather than branching on `Platform.OS`
 * itself, so a screen can keep a single platform-free render path.
 */
export function usesInAppDestructiveConfirm(): boolean {
  return Platform.OS === 'android';
}
