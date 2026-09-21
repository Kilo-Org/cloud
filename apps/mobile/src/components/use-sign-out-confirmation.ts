import { useCallback, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';

/**
 * Sign-out confirmation, including its platform split.
 *
 * Kept in its own module so the Profile screen carries no platform fork: that
 * screen is a caller of the shared side-inset entry point, and
 * `screen-insets.test.ts` pins every such caller to one cross-platform
 * implementation.
 *
 * Android's native `AlertDialog` paints every button with the theme accent, so
 * `Alert.alert`'s `style: 'destructive'` never reaches the screen there.
 * Android opens the in-app `DestructiveConfirmDialog` instead; iOS keeps the
 * native alert, whose destructive choice already renders red.
 */
export function useSignOutConfirmation(onSignOut: () => void) {
  const { t } = useTranslation();
  const [confirmVisible, setConfirmVisible] = useState(false);

  const requestSignOut = useCallback(() => {
    if (Platform.OS === 'android') {
      setConfirmVisible(true);
      return;
    }
    Alert.alert(t('profile.signOutTitle'), t('profile.signOutMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.signOut'), style: 'destructive', onPress: onSignOut },
    ]);
  }, [onSignOut, t]);

  const dismissConfirm = useCallback(() => {
    setConfirmVisible(false);
  }, []);

  const confirmSignOut = useCallback(() => {
    setConfirmVisible(false);
    onSignOut();
  }, [onSignOut]);

  return { confirmVisible, requestSignOut, dismissConfirm, confirmSignOut };
}
