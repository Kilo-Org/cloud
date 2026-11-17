import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import {
  applySystemSearchUpdate,
  indexedSystemSearchFingerprints,
} from '@/lib/native-system-search';
import { replaceNativeSessionCatalog } from '@/lib/app-actions/native-bridge';
import {
  setSessionCatalogLockBestEffort,
  setSessionCatalogVisibleBestEffort,
} from '@/lib/app-actions/session-catalog';
import { isCatalogPublishAllowed, setAppLockStatus } from '@/lib/app-lock-state';
import { BACKGROUND_LOCK_MS, useAppUnlock } from '@/lib/app-unlock-context';
import { queryClient } from '@/lib/query-client';
import {
  collectSystemSearchDocuments,
  type SessionCatalogEntry,
  type SystemSearchCollection,
} from '@/lib/system-search-collect';
import {
  isSystemSearchSyncEnabled,
  SystemSearchIndexSync,
  type SystemSearchIndexUpdate,
} from '@/lib/system-search-sync';
import { reportSystemSearchFailure } from '@/lib/system-search-telemetry';

/** The mount's collect dep: the cache collector bound to the app's client. */
async function collectIndexUpdates(): Promise<SystemSearchCollection> {
  const collection = await collectSystemSearchDocuments(queryClient);
  return collection;
}

/** The mount's apply dep: the plan's `remove` is the bridge's `removeIds`. */
async function applyIndexUpdate(update: SystemSearchIndexUpdate): Promise<void> {
  await applySystemSearchUpdate({ add: update.add, removeIds: update.remove });
}

/**
 * The mount's catalog dep. Only a known-unlocked app publishes: the lock
 * surface covers every other status, so a publish then would put titles back
 * behind it.
 *
 * The sync hands this only a settled sessions read. A launch, or the window a
 * rename leaves while its list entry is refetched, carries no catalog at all,
 * so the device keeps the titles a saved shortcut resolves against.
 */
function applySessionCatalog(sessions: readonly SessionCatalogEntry[]): Promise<boolean> {
  if (!isCatalogPublishAllowed()) {
    return Promise.resolve(false);
  }
  return replaceNativeSessionCatalog(sessions);
}

/**
 * Keeps the phone's own search index in step with the data the app already
 * holds. It renders nothing and fetches nothing: the sync reads the query
 * cache, and the cache events below are what wake it.
 *
 * It mounts inside the signed-in `(app)` group, so unmounting at sign-out
 * drops the cache subscription; `isEnabled` also folds in the sign-out flag so
 * an in-flight teardown never re-indexes. Each return to `active` re-runs the
 * sync, which is the retry for a native write that failed.
 *
 * The same run publishes the App Intents session catalog. It is not a second
 * subscription: the catalog is the session rows of the same collection, it
 * needs the same account fence, and a second owner would have to repeat the
 * coalescing and the fencing to reach the same guarantee.
 */
export function SystemSearchIndexMount(): null {
  const { status, enabled } = useAppUnlock();
  const syncRef = useRef<SystemSearchIndexSync | null>(null);

  useEffect(() => {
    const sync = new SystemSearchIndexSync({
      queryClient,
      collect: collectIndexUpdates,
      fingerprints: indexedSystemSearchFingerprints,
      apply: applyIndexUpdate,
      applySessions: applySessionCatalog,
      report: error => {
        reportSystemSearchFailure('sync', error);
      },
      isEnabled: isSystemSearchSyncEnabled,
    });
    syncRef.current = sync;
    const detach = sync.attach();
    const appStateSubscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        void sync.syncNow();
      }
    });
    return () => {
      appStateSubscription.remove();
      detach();
      syncRef.current = null;
    };
  }, []);

  // The catalog follows the one gate that hides content. Every status other
  // than `unlocked` hides the titles — including a launch that is still reading
  // the preference, which the lock surface already covers — and the unlock edge
  // shows them again. Hiding, not wiping: the App Intents can be asked to
  // resolve a session a saved shortcut names while the system starts the app for
  // a run, and that answer must not depend on a publish that has not happened
  // yet in this process. The publish above still refuses while the gate stands,
  // and the account boundaries are the ones that wipe.
  //
  // The unlock edge is also the retry for a publish that the gate refused: the
  // run that would have carried the titles happened while the lock stood, so
  // nothing else would re-publish them until an unrelated cache write.
  useEffect(() => {
    setAppLockStatus(status);
    setSessionCatalogVisibleBestEffort(status === 'unlocked');
    if (status === 'unlocked') {
      void syncRef.current?.syncNow();
    }
  }, [status]);

  // The lock's own switch, and the interval it allows in the background, reach
  // the native store. Without them the entity queries would keep answering for
  // the whole time the app sits in the background past the interval: they run
  // in a launched process, where no JavaScript and no lock surface exists. The
  // status edges above still own what the person can see in the foreground.
  //
  // That push waits for the preference read to settle. The native store's
  // withholding check returns early while the persisted switch is off, before
  // it consults the visibility the status effect pushes, so writing this
  // process's not-yet-read `false` would open the previous process's titles for
  // the length of the read — and persist that through a launch killed inside
  // it. Until the read answers, the switch the last launch stored keeps doing
  // what the person chose.
  useEffect(() => {
    if (status === 'preference-loading') {
      return;
    }
    setSessionCatalogLockBestEffort(enabled, BACKGROUND_LOCK_MS);
  }, [enabled, status]);
  return null;
}
