import * as SecureStore from '@/lib/auth/secure-store';
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
  await replayVerifiedSnapshot(clearActivityKitDeniedIfAvailable);
}

/**
 * Start the Live Activity for work that was already live when the user granted
 * notification permission. The sink skipped that start while the permission
 * was missing, and the next publish can be minutes away.
 */
export async function replayGlanceableLiveActivity(): Promise<void> {
  if (Platform.OS !== 'ios') {
    return;
  }
  await replayVerifiedSnapshot(() => true);
}

/**
 * Re-emit the current snapshot to every sink once the stored identity still
 * owns it. `admit` runs after every fence passes and can veto the replay.
 */
async function replayVerifiedSnapshot(admit: () => boolean): Promise<void> {
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
    !admit()
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
