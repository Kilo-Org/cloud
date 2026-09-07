import { Alert, Linking } from 'react-native';

import { i18n } from '@/i18n';

/**
 * The one in-app Open Settings alert for a denied Android notification
 * permission. Shown at most once per missing permission, and only from a widget
 * tap that cannot start the ongoing notification — never on publisher start.
 */

let alertShown = false;

export function showAndroidPermissionAlertOnce(): void {
  if (alertShown) {
    return;
  }
  alertShown = true;
  Alert.alert(i18n.t('notifications.disabledTitle'), i18n.t('notifications.disabledMessage'), [
    { text: i18n.t('common.cancel'), style: 'cancel' },
    { text: i18n.t('common.openSettings'), onPress: () => void Linking.openSettings() },
  ]);
}

/** Test-only: drop the once-per-missing-permission latch between cases. */
export function _resetAndroidPermissionAlertForTests(): void {
  alertShown = false;
}
