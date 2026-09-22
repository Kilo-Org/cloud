import { useCallback, useState } from 'react';

/**
 * Sign-out confirmation.
 *
 * One destructive confirm for both platforms: the in-app
 * `DestructiveConfirmDialog` carries the red affordance on iOS and Android
 * alike. The native alert cannot be the shared implementation — Android's
 * `AlertDialog` paints every button with the theme accent, so
 * `Alert.alert`'s `style: 'destructive'` never reaches the screen there — so
 * this hook never branches on the platform.
 *
 * Kept in its own module so the Profile screen holds no confirmation state:
 * that screen reads its side insets from the shared entry point, and
 * `screen-insets.test.ts` pins every caller of it to one cross-platform
 * implementation.
 */
export function useSignOutConfirmation(onSignOut: () => void) {
  const [confirmVisible, setConfirmVisible] = useState(false);

  const requestSignOut = useCallback(() => {
    setConfirmVisible(true);
  }, []);

  const dismissConfirm = useCallback(() => {
    setConfirmVisible(false);
  }, []);

  const confirmSignOut = useCallback(() => {
    setConfirmVisible(false);
    onSignOut();
  }, [onSignOut]);

  return { confirmVisible, requestSignOut, dismissConfirm, confirmSignOut };
}
