import * as SecureStore from 'expo-secure-store';
import { Alert, Linking, Platform } from 'react-native';

import {
  buildOpaqueScopeKey,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { clearActivityKitDeniedIfAvailable, getActivityKitDenied } from '@/glanceable-ios/ios-sink';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { getTerminalBlankEpoch } from '@/lib/glanceable/cleanup';
import { getLastGlanceableSnapshot, getLocalScopeKey } from '@/lib/glanceable/persist';
import { readGlanceableEnabled } from '@/lib/glanceable/enabled';
import { getGlanceableSinks } from '@/lib/glanceable/sink-registry';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { i18n } from '@/i18n';

/**
 * The one in-app Open Settings alert for an ActivityKit-unavailable surface.
 * Shown at most once per process when the Agents tab regains focus — never
 * auto-alerted from the publisher, so the publisher stays a pure state machine.
 */

let alertShown = false;

export async function showActivityKitDisabledAlertOnce(): Promise<void> {
  if (Platform.OS !== 'ios' || alertShown) {
    return;
  }
  if (!getActivityKitDenied()) {
    return;
  }
  // Never ask for an OS permission the user turned the feature off for.
  if (!(await readGlanceableEnabled())) {
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

/**
 * Recover a once-denied ActivityKit surface after verifying the stored identity
 * and current snapshot. Clear denial even while idle so later work can start
 * without another focus event; replay only eligible work.
 */
export async function recoverGlanceableActivityKit(): Promise<void> {
  if (Platform.OS !== 'ios' || !getActivityKitDenied()) {
    return;
  }
  if (!(await readGlanceableEnabled())) {
    return;
  }
  const authEpoch = currentAuthEpoch();
  const blankEpoch = getTerminalBlankEpoch();
  const scopeKey = getLocalScopeKey();
  const snapshot = getLastGlanceableSnapshot();
  if (snapshot === null || snapshot.scopeKey !== scopeKey) {
    return;
  }
  let userId: string | null = null;
  let organizationId: string | null = null;
  try {
    [userId, organizationId] = await Promise.all([
      SecureStore.getItemAsync(ACTIVE_USER_ID_KEY),
      SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY),
    ]);
  } catch {
    // A failed organization read must not be treated as the personal scope.
    return;
  }
  if (
    currentAuthEpoch() !== authEpoch ||
    getTerminalBlankEpoch() !== blankEpoch ||
    getLocalScopeKey() !== scopeKey ||
    getLastGlanceableSnapshot() !== snapshot ||
    userId === null ||
    buildOpaqueScopeKey({ userId, organizationId }) !== scopeKey ||
    !clearActivityKitDeniedIfAvailable()
  ) {
    return;
  }
  if (!isEligibleGlanceableWork(snapshot)) {
    return;
  }
  for (const sink of getGlanceableSinks()) {
    sink.startOrUpdate(snapshot, { userId, organizationId });
  }
}
