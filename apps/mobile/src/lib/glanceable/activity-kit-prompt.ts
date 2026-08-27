import { Alert, Linking, Platform } from 'react-native';

import { getActivityKitDenied } from '@/glanceable-ios/ios-sink';
import { i18n } from '@/i18n';

/**
 * The one in-app Open Settings alert for an ActivityKit-unavailable surface.
 * Shown at most once per process when the Agents tab regains focus — never
 * auto-alerted from the publisher, so the publisher stays a pure state machine.
 */

let alertShown = false;

export function showActivityKitDisabledAlertOnce(): void {
  if (Platform.OS !== 'ios' || alertShown) {
    return;
  }
  if (!getActivityKitDenied()) {
    return;
  }
  alertShown = true;
  Alert.alert(
    i18n.t('glanceable.activityKitDisabledTitle'),
    i18n.t('glanceable.activityKitDisabledBody'),
    [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      { text: i18n.t('common.openSettings'), onPress: () => void Linking.openSettings() },
    ]
  );
}

/** Test-only: drop the once-per-process latch between cases. */
export function _resetActivityKitPromptForTests(): void {
  alertShown = false;
}
