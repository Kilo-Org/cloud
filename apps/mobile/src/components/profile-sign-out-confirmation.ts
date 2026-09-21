import { Alert } from 'react-native';

import { needsInAppDestructiveConfirm } from '@/lib/destructive-confirm-platform';

type SignOutConfirmationCopy = {
  title: string;
  message: string;
  cancelLabel: string;
  confirmLabel: string;
};

type SignOutConfirmationActions = {
  /** Runs the sign-out the user confirmed. */
  signOut: () => void;
  /** Opens the in-app `DestructiveConfirmDialog` Android renders instead. */
  showInAppConfirmation: () => void;
};

/**
 * Confirm sign-out with a destructive affordance on both platforms.
 *
 * Android's native `AlertDialog` paints every button with the theme accent, so
 * `Alert.alert`'s `style: 'destructive'` never reaches the screen there: the
 * caller opens `DestructiveConfirmDialog` instead. iOS honors the style and
 * keeps the native alert. The fork lives here rather than in
 * `profile-screen.tsx`, whose cross-platform safe-area alignment path must not
 * branch on the platform (`lib/screen-insets.test.ts`); the platform read is
 * `needsInAppDestructiveConfirm` from `@/lib/destructive-confirm-platform`.
 */
export function signOutWithConfirmation(
  copy: SignOutConfirmationCopy,
  actions: SignOutConfirmationActions
): void {
  if (needsInAppDestructiveConfirm()) {
    actions.showInAppConfirmation();
    return;
  }
  Alert.alert(copy.title, copy.message, [
    { text: copy.cancelLabel, style: 'cancel' },
    { text: copy.confirmLabel, style: 'destructive', onPress: actions.signOut },
  ]);
}
