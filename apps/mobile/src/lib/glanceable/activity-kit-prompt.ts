import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  buildOpaqueScopeKey,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { clearActivityKitDeniedIfAvailable, getActivityKitDenied } from '@/glanceable-ios/ios-sink';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { getTerminalBlankEpoch } from '@/lib/glanceable/cleanup';
import { getLastGlanceableSnapshot, getLocalScopeKey } from '@/lib/glanceable/persist';
import { forEachSink } from '@/lib/glanceable/sink-registry';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

/**
 * Recover a once-denied ActivityKit surface after verifying the stored identity
 * and current snapshot. Clear denial even while idle so later work can start
 * without another focus event; replay only eligible work.
 */
export async function recoverGlanceableActivityKit(): Promise<void> {
  if (Platform.OS !== 'ios' || !getActivityKitDenied()) {
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
  forEachSink('recover_start_or_update', sink => {
    sink.startOrUpdate(snapshot, { userId, organizationId });
  });
}
