import { Alert, Platform } from 'react-native';

type DestructiveConfirmOptions = {
  title: string;
  message: string;
  cancelLabel: string;
  confirmLabel: string;
  onConfirm: () => void;
  /**
   * Rendered on Android instead of the native alert: Android's `AlertDialog`
   * paints every button with the theme accent, so `Alert.alert`'s destructive
   * style never reaches the screen there (iOS honors it and keeps the alert).
   */
  renderInApp: () => void;
};

/**
 * Confirms a destructive action with the platform's destructive affordance:
 * iOS keeps the native alert, Android renders the caller's in-app dialog.
 *
 * A screen with an alignment path reads its geometry from one place and must
 * not fork on the platform, so the fork lives here rather than in the screen.
 */
export function confirmDestructiveAction({
  title,
  message,
  cancelLabel,
  confirmLabel,
  onConfirm,
  renderInApp,
}: DestructiveConfirmOptions): void {
  if (Platform.OS === 'android') {
    renderInApp();
    return;
  }
  Alert.alert(title, message, [
    { text: cancelLabel, style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}
