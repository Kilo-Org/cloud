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
import { getGlanceableSinks } from '@/lib/glanceable/sink-registry';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
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

async function readSecureStoreValue(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

/**
 * Re-emit the last eligible snapshot after a once-denied ActivityKit surface
 * became available again. Reads the active-user and selected-organization hints
 * from SecureStore exactly as `notifications.ts` does, so the re-emitted token
 * registration keeps the right scope. No-op when the latch was never denied,
 * was not cleared, or the persisted snapshot has no eligible work.
 */
export async function recoverGlanceableActivityKit(): Promise<void> {
  if (Platform.OS !== 'ios' || !getActivityKitDenied()) {
    return;
  }
  const authEpoch = currentAuthEpoch();
  const blankEpoch = getTerminalBlankEpoch();
  const scopeKey = getLocalScopeKey();
  const snapshot = getLastGlanceableSnapshot();
  if (snapshot === null || snapshot.scopeKey !== scopeKey || !isEligibleGlanceableWork(snapshot)) {
    return;
  }
  const [userId, organizationId] = await Promise.all([
    readSecureStoreValue(ACTIVE_USER_ID_KEY),
    readSecureStoreValue(ORGANIZATION_STORAGE_KEY),
  ]);
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
  for (const sink of getGlanceableSinks()) {
    sink.startOrUpdate(snapshot, { userId, organizationId });
  }
}
